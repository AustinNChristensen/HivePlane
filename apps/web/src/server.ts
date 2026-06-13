import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BeeHeartbeatSchema,
  BeeRegistrationRequestSchema,
  BootstrapTokenCreateRequestSchema,
  JobCompleteRequestSchema,
  JobEventBatchSchema,
  type BeeHeartbeat,
  type BeeRegistrationRequest,
  type BootstrapTokenCreateRequest,
} from "@hiveplane/protocol";
import {
  extractBearer,
  formatPairingKeyForDisplay,
  generateBootstrapToken,
  generatePairingKey,
  generateSessionToken,
  getRequiredAdminToken,
  isAuthRequired,
  looksLikeBootstrapToken,
  looksLikePairingKey,
  looksLikeSessionToken,
  PAIRING_KEY_DEFAULT_TTL_MS,
  safeEquals,
  sha256Hex,
  verifyBeeSignature,
  type BootstrapTokenRecord,
  type PairingKeyRecord,
  type SessionRecord,
} from "./auth.js";
import { getHiveInfo } from "./hive-info.js";
import {
  appendEvents,
  claimPendingJobs,
  completeJob,
  CreateJobRequestSchema,
  createJob,
  createJobsState,
  findJob,
  listJobs,
  type JobRecord,
  type JobsState,
} from "./jobs.js";

export type HiveBeeRecord = {
  beeId: string;
  beeName?: string;
  publicKey?: string;
  daemonVersion: string;
  status: BeeHeartbeat["status"];
  activeJobs: number;
  healthChecks: BeeHeartbeat["healthChecks"];
  firstSeenAt: string;
  lastSeenAt: string;
  heartbeatCount: number;
};

/**
 * Tracks failed pairing-key attempts for soft rate-limiting. Keyed by remote
 * address (or `"unknown"` if we can't read one). On every successful
 * registration the entry is cleared.
 */
export type PairingAttemptRecord = {
  /** Failures within the current 60s sliding window. */
  recentFailures: number;
  /** Wall-clock ms when the window started. */
  windowStart: number;
  /** If set, no attempts are accepted from this remote until this ms. */
  lockoutUntil?: number;
};

export type HiveServerState = {
  bees: Map<string, HiveBeeRecord>;
  /** Bootstrap tokens keyed by hash of the raw token. */
  bootstrapTokens: Map<string, BootstrapTokenRecord>;
  /** Sessions keyed by hash of the raw session token. */
  sessions: Map<string, SessionRecord>;
  /**
   * The single currently-active pairing key, or `undefined` if one has not
   * been generated yet. Populated lazily on first GET /api/pairing-key.
   */
  activePairingKey?: PairingKeyRecord;
  /**
   * History of recently-rotated pairing keys, kept long enough for an
   * inflight-on-rotate registration to fail with a clearer "expired" message
   * rather than "not recognized". Capped at 8 entries.
   */
  retiredPairingKeys: PairingKeyRecord[];
  /** Per-remote pairing-key attempt log for rate-limit decisions. */
  pairingAttempts: Map<string, PairingAttemptRecord>;
  /** Jobs keyed by jobId (queued/assigned/running/...) — see jobs.ts. */
  jobsState: JobsState;
};

export type CreateHiveServerOptions = {
  state?: HiveServerState;
  now?: () => Date;
  /** Override directory where install scripts live. Defaults to repo `infra/install`. */
  installScriptsDir?: string;
  /** Override directory for the static dashboard. Defaults to `apps/web/public`. */
  publicDir?: string;
  /** Override admin token (otherwise read from HIVEPLANE_ADMIN_TOKEN). Useful for tests. */
  adminToken?: string;
  /** Override the auth-required toggle. Useful for tests. */
  authRequired?: boolean;
  /**
   * Called after every state-mutating request finishes successfully. The
   * persistence layer (`apps/web/src/persistence.ts`) wires this to a
   * debounced atomic file write. Tests typically pass a `vi.fn()` to assert
   * mutation paths fire the hook, or omit it entirely.
   */
  onMutation?: () => void;
  /**
   * What the runtime actually bound to. Used by `GET /api/hive-info` to
   * compute a recommended URL for the dashboard's pairing-key card; not
   * used for binding itself (the listener is set up by cli.ts before this
   * server runs).
   */
  bindHost?: string;
  bindPort?: number;
};

export function createHiveServerState(): HiveServerState {
  return {
    bees: new Map(),
    bootstrapTokens: new Map(),
    sessions: new Map(),
    retiredPairingKeys: [],
    pairingAttempts: new Map(),
    jobsState: createJobsState(),
  };
}

/** How long a freshly-minted pairing key stays valid by default. */
function pairingKeyTtlMs(): number {
  const env = process.env.HIVEPLANE_PAIRING_KEY_TTL_MS;
  if (!env) return PAIRING_KEY_DEFAULT_TTL_MS;
  const parsed = Number.parseInt(env, 10);
  if (!Number.isFinite(parsed) || parsed < 60_000) return PAIRING_KEY_DEFAULT_TTL_MS;
  return parsed;
}

/** Per-remote: max consecutive failures before a 60s soft lockout. */
const PAIRING_FAILURE_LIMIT_PER_REMOTE = 10;
/** Per-remote: lockout window after the failure limit is hit. */
const PAIRING_LOCKOUT_MS = 60_000;
/** Sliding window used for the per-remote failure counter. */
const PAIRING_FAILURE_WINDOW_MS = 60_000;

/**
 * Mint (or recycle) the active pairing key. Idempotent unless `force` is set:
 * if there's already an unexpired, unconsumed key we return that one;
 * otherwise we generate a new one, retire the previous, and clear all per-
 * remote rate-limit state (a rotation is the operator saying "fresh start").
 */
export function ensureActivePairingKey(
  state: HiveServerState,
  now: Date,
  force = false,
): PairingKeyRecord {
  const existing = state.activePairingKey;
  if (!force && existing && !existing.consumedAt && existing.expiresAt.getTime() > now.getTime()) {
    return existing;
  }

  if (existing) {
    state.retiredPairingKeys.unshift(existing);
    if (state.retiredPairingKeys.length > 8) {
      state.retiredPairingKeys.length = 8;
    }
  }

  const { keyId, code, tokenHash } = generatePairingKey();
  const record: PairingKeyRecord = {
    keyId,
    code,
    tokenHash,
    createdAt: now,
    expiresAt: new Date(now.getTime() + pairingKeyTtlMs()),
  };
  state.activePairingKey = record;
  // A rotate is also a hard reset on rate-limit state — the previous key is
  // gone, so old attempt counts no longer apply.
  if (force) state.pairingAttempts.clear();
  return record;
}

function serializePairingKey(record: PairingKeyRecord): {
  keyId: string;
  code: string;
  display: string;
  createdAt: string;
  expiresAt: string;
} {
  return {
    keyId: record.keyId,
    code: record.code,
    display: formatPairingKeyForDisplay(record.code),
    createdAt: record.createdAt.toISOString(),
    expiresAt: record.expiresAt.toISOString(),
  };
}

export function upsertBeeHeartbeat(
  state: HiveServerState,
  heartbeat: BeeHeartbeat,
  now = new Date(),
): HiveBeeRecord {
  const existing = state.bees.get(heartbeat.beeId);
  const timestamp = heartbeat.timestamp || now.toISOString();
  const record: HiveBeeRecord = {
    beeId: heartbeat.beeId,
    ...(existing?.beeName ? { beeName: existing.beeName } : {}),
    ...(existing?.publicKey ? { publicKey: existing.publicKey } : {}),
    daemonVersion: heartbeat.daemonVersion,
    status: heartbeat.status,
    activeJobs: heartbeat.activeJobs,
    healthChecks: heartbeat.healthChecks,
    firstSeenAt: existing?.firstSeenAt ?? timestamp,
    lastSeenAt: timestamp,
    heartbeatCount: (existing?.heartbeatCount ?? 0) + 1,
  };

  state.bees.set(heartbeat.beeId, record);
  return record;
}

function findBeeIdByPublicKey(state: HiveServerState, publicKey: string): string | undefined {
  for (const [beeId, bee] of state.bees.entries()) {
    if (bee.publicKey && safeEquals(bee.publicKey, publicKey)) return beeId;
  }
  return undefined;
}

function deleteBee(state: HiveServerState, beeId: string): boolean {
  const deleted = state.bees.delete(beeId);
  if (!deleted) return false;

  for (const [tokenHash, session] of state.sessions.entries()) {
    if (session.beeId === beeId) state.sessions.delete(tokenHash);
  }
  return true;
}

function defaultInstallScriptsDir(): string {
  // apps/web/src/server.ts → ../../../infra/install
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, "..", "..", "..", "infra", "install");
}

function defaultPublicDir(): string {
  // apps/web/src/server.ts → ../public
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, "..", "public");
}

const INSTALL_SCRIPT_NAMES = new Set(["bee.sh", "hive.sh"]);

const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days
const OFFLINE_AFTER_MS = 2 * 60 * 1000;

const HIVE_VERSION = "0.0.7";

export function createHiveServer(options: CreateHiveServerOptions = {}) {
  const state = options.state ?? createHiveServerState();
  const now = options.now ?? (() => new Date());
  const installScriptsDir = options.installScriptsDir ?? defaultInstallScriptsDir();
  const publicDir = options.publicDir ?? defaultPublicDir();
  const adminToken = options.adminToken ?? getRequiredAdminToken();
  const authRequired = options.authRequired ?? isAuthRequired();
  // No-op when persistence isn't attached (tests, --no-persist, etc.).
  const markDirty = options.onMutation ?? (() => {});
  // Bind info for the /api/hive-info endpoint. Defaults match the runtime
  // fallbacks in cli.ts so tests that don't pass these still get sane output.
  const bindHost = options.bindHost ?? "0.0.0.0";
  const bindPort = options.bindPort ?? 4483;

  return createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://localhost");

      // Dashboard: GET /, /dashboard, /index.html all serve the static index.html.
      if (
        request.method === "GET" &&
        (url.pathname === "/" ||
          url.pathname === "/dashboard" ||
          url.pathname === "/dashboard/" ||
          url.pathname === "/index.html")
      ) {
        const indexPath = join(publicDir, "index.html");
        try {
          const html = readFileSync(indexPath, "utf8");
          response.writeHead(200, {
            "content-type": "text/html; charset=utf-8",
            "cache-control": "no-store",
          });
          response.end(html);
          return;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            return sendJson(response, 404, {
              error: "dashboard_not_built",
              message: `dashboard index.html not found at ${indexPath}. The Hive process may be running an older revision than the source on disk — restart it.`,
            });
          }
          throw error;
        }
      }

      if (request.method === "GET" && url.pathname === "/healthz") {
        return sendJson(response, 200, {
          ok: true,
          service: "hiveplane-hive",
          version: HIVE_VERSION,
        });
      }

      if (request.method === "GET" && url.pathname === "/version") {
        return sendJson(response, 200, { version: HIVE_VERSION, service: "hiveplane-hive" });
      }

      // GET /api/hive-info — recommended Hive URL for a remote Bee, plus the
      // bind config. Tailscale-aware. The dashboard hits this when the
      // operator's address bar shows a localhost URL — `localhost:4483`
      // isn't useful to a Bee on another machine, so we surface the
      // Tailscale MagicDNS name (or hostname) instead.
      if (request.method === "GET" && url.pathname === "/api/hive-info") {
        const info = await getHiveInfo(bindHost, bindPort);
        return sendJson(response, 200, info);
      }

      if (request.method === "GET" && url.pathname === "/api/bees") {
        return sendJson(response, 200, { bees: serializeBees(state, now()) });
      }

      const deleteBeeMatch = /^\/api\/bees\/([^/]+)$/.exec(url.pathname);
      if (request.method === "DELETE" && deleteBeeMatch) {
        if (!checkAdmin(request, response, adminToken)) return;
        const beeId = decodeURIComponent(deleteBeeMatch[1] ?? "");
        if (!deleteBee(state, beeId)) {
          return sendJson(response, 404, { error: "not_found", reason: "bee not registered" });
        }
        markDirty();
        return sendJson(response, 200, { deleted: true, beeId });
      }

      if (request.method === "POST" && url.pathname === "/api/bootstrap-tokens") {
        if (!checkAdmin(request, response, adminToken)) return;
        const body = (await readJson(request)).body as unknown;
        const parsed = BootstrapTokenCreateRequestSchema.safeParse(
          ensureType(body, "bootstrap_token.create.request"),
        );
        if (!parsed.success) {
          return sendJson(response, 400, {
            error: "bad_request",
            message: parsed.error.message,
          });
        }
        const created = createBootstrapToken(state, parsed.data, now());
        markDirty();
        return sendJson(response, 200, created);
      }

      // GET /api/pairing-key — admin-gated; returns (and lazily mints) the
      // current short pairing key for human-driven Bee onboarding.
      if (request.method === "GET" && url.pathname === "/api/pairing-key") {
        if (!checkAdmin(request, response, adminToken)) return;
        const record = ensureActivePairingKey(state, now());
        return sendJson(response, 200, {
          type: "pairing_key.current",
          ...serializePairingKey(record),
        });
      }

      // POST /api/pairing-key/rotate — admin-gated; mints a fresh key and
      // invalidates the previous one.
      if (request.method === "POST" && url.pathname === "/api/pairing-key/rotate") {
        if (!checkAdmin(request, response, adminToken)) return;
        const record = ensureActivePairingKey(state, now(), true);
        return sendJson(response, 200, {
          type: "pairing_key.rotated",
          ...serializePairingKey(record),
        });
      }

      if (request.method === "POST" && url.pathname === "/api/bees/register") {
        const { body, raw: _raw } = await readJson(request);
        const parsed = BeeRegistrationRequestSchema.safeParse(
          ensureType(body, "bee.registration.request"),
        );
        if (!parsed.success) {
          return sendJson(response, 400, {
            error: "bad_request",
            message: parsed.error.message,
          });
        }
        const result = registerBee(state, parsed.data, now(), {
          remote: remoteAddress(request),
        });
        if ("error" in result) {
          const status = result.error === "rate_limited" ? 429 : 401;
          return sendJson(response, status, result);
        }
        markDirty();
        return sendJson(response, 200, result);
      }

      if (request.method === "POST" && url.pathname === "/api/bees/heartbeat") {
        const { body, raw } = await readJson(request);
        const parsed = BeeHeartbeatSchema.safeParse(body);
        if (!parsed.success) {
          return sendJson(response, 400, {
            error: "bad_request",
            message: parsed.error.message,
          });
        }
        const heartbeat = parsed.data;
        const authResult = authenticateHeartbeat(request, raw, heartbeat, state, authRequired);
        if (!authResult.ok) {
          return sendJson(response, 401, { error: "unauthorized", reason: authResult.reason });
        }
        const bee = upsertBeeHeartbeat(state, heartbeat, now());
        // Hand back any pending jobs and mark them as assigned.
        const jobs = claimPendingJobs(state.jobsState, heartbeat.beeId, now());
        markDirty();
        return sendJson(response, 200, { accepted: true, bee, jobs });
      }

      // POST /api/bees/:beeId/jobs — admin-gated; create a job for a bee.
      const createJobMatch = /^\/api\/bees\/([^/]+)\/jobs$/.exec(url.pathname);
      if (request.method === "POST" && createJobMatch) {
        if (!checkAdmin(request, response, adminToken)) return;
        const beeId = decodeURIComponent(createJobMatch[1] ?? "");
        if (!state.bees.has(beeId)) {
          return sendJson(response, 404, { error: "not_found", reason: "bee not registered" });
        }
        const { body } = await readJson(request);
        const parsed = CreateJobRequestSchema.safeParse(body);
        if (!parsed.success) {
          return sendJson(response, 400, {
            error: "bad_request",
            message: parsed.error.message,
          });
        }
        const job = createJob(state.jobsState, beeId, parsed.data, now());
        markDirty();
        return sendJson(response, 200, { job: serializeJob(job) });
      }

      // POST /api/jobs/:jobId/events — bee streams events.
      const eventsMatch = /^\/api\/jobs\/([^/]+)\/events$/.exec(url.pathname);
      if (request.method === "POST" && eventsMatch) {
        const jobId = decodeURIComponent(eventsMatch[1] ?? "");
        const job = findJob(state.jobsState, jobId);
        if (!job) {
          return sendJson(response, 404, { error: "not_found" });
        }
        const { body, raw } = await readJson(request);
        const parsed = JobEventBatchSchema.safeParse(ensureType(body, "job.events.append"));
        if (!parsed.success) {
          return sendJson(response, 400, {
            error: "bad_request",
            message: parsed.error.message,
          });
        }
        const beeAuth = authenticateBee(request, raw, parsed.data.beeId, state, authRequired);
        if (!beeAuth.ok) {
          return sendJson(response, 401, { error: "unauthorized", reason: beeAuth.reason });
        }
        if (parsed.data.beeId !== job.beeId) {
          return sendJson(response, 403, { error: "forbidden", reason: "job is not yours" });
        }
        appendEvents(state.jobsState, jobId, parsed.data.events);
        markDirty();
        return sendJson(response, 200, { accepted: true, eventCount: job.events.length });
      }

      // POST /api/jobs/:jobId/complete — bee finalizes.
      const completeMatch = /^\/api\/jobs\/([^/]+)\/complete$/.exec(url.pathname);
      if (request.method === "POST" && completeMatch) {
        const jobId = decodeURIComponent(completeMatch[1] ?? "");
        const job = findJob(state.jobsState, jobId);
        if (!job) {
          return sendJson(response, 404, { error: "not_found" });
        }
        const { body, raw } = await readJson(request);
        const parsed = JobCompleteRequestSchema.safeParse(ensureType(body, "job.complete"));
        if (!parsed.success) {
          return sendJson(response, 400, {
            error: "bad_request",
            message: parsed.error.message,
          });
        }
        const beeAuth = authenticateBee(request, raw, parsed.data.beeId, state, authRequired);
        if (!beeAuth.ok) {
          return sendJson(response, 401, { error: "unauthorized", reason: beeAuth.reason });
        }
        if (parsed.data.beeId !== job.beeId) {
          return sendJson(response, 403, { error: "forbidden", reason: "job is not yours" });
        }
        const updated = completeJob(state.jobsState, jobId, parsed.data, now());
        markDirty();
        return sendJson(response, 200, { job: updated ? serializeJob(updated) : null });
      }

      // GET /api/jobs/:jobId — admin-gated inspection.
      const getJobMatch = /^\/api\/jobs\/([^/]+)$/.exec(url.pathname);
      if (request.method === "GET" && getJobMatch) {
        if (!checkAdmin(request, response, adminToken)) return;
        const jobId = decodeURIComponent(getJobMatch[1] ?? "");
        const job = findJob(state.jobsState, jobId);
        if (!job) return sendJson(response, 404, { error: "not_found" });
        return sendJson(response, 200, { job: serializeJob(job) });
      }

      // GET /api/jobs?beeId=… — admin list.
      if (request.method === "GET" && url.pathname === "/api/jobs") {
        if (!checkAdmin(request, response, adminToken)) return;
        const beeId = url.searchParams.get("beeId") ?? undefined;
        const jobs = listJobs(state.jobsState, beeId ? { beeId } : undefined).map(serializeJob);
        return sendJson(response, 200, { jobs });
      }

      if (request.method === "GET" && url.pathname.startsWith("/install/")) {
        const name = url.pathname.slice("/install/".length);
        if (!INSTALL_SCRIPT_NAMES.has(name)) {
          return sendJson(response, 404, { error: "not_found" });
        }
        const filePath = join(installScriptsDir, name);
        try {
          const body = readFileSync(filePath, "utf8");
          response.writeHead(200, {
            "content-type": "text/x-shellscript; charset=utf-8",
            "cache-control": "no-store",
          });
          response.end(body);
          return;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            return sendJson(response, 404, { error: "install_script_missing", name });
          }
          throw error;
        }
      }

      return sendJson(response, 404, { error: "not_found" });
    } catch (error) {
      return sendJson(response, 400, {
        error: "bad_request",
        message: error instanceof Error ? error.message : "Unknown error",
      });
    }
  });
}

function checkAdmin(
  request: IncomingMessage,
  response: ServerResponse,
  adminToken: string | undefined,
): boolean {
  if (!adminToken) {
    sendJson(response, 503, {
      error: "admin_disabled",
      message:
        "Admin endpoints disabled: HIVEPLANE_ADMIN_TOKEN is not set on this Hive. Set it to enable bootstrap-token issuance.",
    });
    return false;
  }
  const bearer = extractBearer(request);
  if ("error" in bearer) {
    sendJson(response, 401, { error: "unauthorized", reason: bearer.error });
    return false;
  }
  if (!safeEquals(bearer.token, adminToken)) {
    sendJson(response, 401, { error: "unauthorized", reason: "admin token mismatch" });
    return false;
  }
  return true;
}

export function createBootstrapToken(
  state: HiveServerState,
  payload: BootstrapTokenCreateRequest,
  now: Date,
): { type: "bootstrap_token.create.response"; tokenId: string; token: string; expiresAt: string } {
  const { tokenId, rawToken, tokenHash } = generateBootstrapToken();
  const expiresAt = new Date(now.getTime() + payload.expiresInSeconds * 1000);
  state.bootstrapTokens.set(tokenHash, {
    tokenId,
    tokenHash,
    expiresAt,
    ...(payload.beeName ? { beeName: payload.beeName } : {}),
    labels: payload.labels,
  });
  return {
    type: "bootstrap_token.create.response",
    tokenId,
    token: rawToken,
    expiresAt: expiresAt.toISOString(),
  };
}

type RegisterError = { error: string; reason: string };

type RegistrationOptions = {
  /** Remote identifier used to scope pairing-key rate-limiting. */
  remote?: string;
};

type RegistrationSuccess = {
  type: "bee.registration.response";
  beeId: string;
  sessionToken: string;
  sessionExpiresAt: string;
  acceptedAt: string;
};

export function registerBee(
  state: HiveServerState,
  request: BeeRegistrationRequest,
  now: Date,
  options: RegistrationOptions = {},
): RegistrationSuccess | RegisterError {
  if (request.bootstrapToken && request.pairingKey) {
    // Should never reach here because the schema rejects this — defence in
    // depth.
    return { error: "bad_request", reason: "supply only one of bootstrapToken / pairingKey" };
  }

  if (request.bootstrapToken) {
    return registerBeeWithBootstrapToken(state, request, request.bootstrapToken, now);
  }
  if (request.pairingKey) {
    return registerBeeWithPairingKey(state, request, request.pairingKey, now, options);
  }
  return { error: "bad_request", reason: "missing bootstrapToken / pairingKey" };
}

function registerBeeWithBootstrapToken(
  state: HiveServerState,
  request: BeeRegistrationRequest,
  bootstrapToken: string,
  now: Date,
): RegistrationSuccess | RegisterError {
  if (!looksLikeBootstrapToken(bootstrapToken)) {
    return { error: "unauthorized", reason: "bootstrap token shape invalid" };
  }
  const tokenHash = sha256Hex(bootstrapToken);
  const tokenRecord = state.bootstrapTokens.get(tokenHash);
  if (!tokenRecord) {
    return { error: "unauthorized", reason: "bootstrap token not recognized" };
  }
  if (tokenRecord.consumedAt) {
    return { error: "unauthorized", reason: "bootstrap token already consumed" };
  }
  if (tokenRecord.expiresAt.getTime() < now.getTime()) {
    return { error: "unauthorized", reason: "bootstrap token expired" };
  }

  const beeId =
    findBeeIdByPublicKey(state, request.publicKey) ??
    `bee_${tokenRecord.tokenId.slice(3)}_${sha256Hex(request.publicKey).slice(0, 12)}`;
  tokenRecord.consumedAt = now;
  tokenRecord.consumedByBeeId = beeId;
  return finalizeRegistration(state, request, beeId, now);
}

function registerBeeWithPairingKey(
  state: HiveServerState,
  request: BeeRegistrationRequest,
  pairingKey: string,
  now: Date,
  options: RegistrationOptions,
): RegistrationSuccess | RegisterError {
  const remote = options.remote ?? "unknown";
  const lockout = checkPairingLockout(state, remote, now);
  if (lockout) return lockout;

  if (!looksLikePairingKey(pairingKey)) {
    recordPairingFailure(state, remote, now);
    return { error: "unauthorized", reason: "pairing key shape invalid" };
  }

  const tokenHash = sha256Hex(pairingKey);
  const active = state.activePairingKey;
  const matchesActive = active && safeEquals(active.tokenHash, tokenHash);

  if (!matchesActive) {
    // Was it a recently-rotated key? Surface a clearer message in that case.
    const retired = state.retiredPairingKeys.find((r) => safeEquals(r.tokenHash, tokenHash));
    recordPairingFailure(state, remote, now);
    if (retired) {
      return {
        error: "unauthorized",
        reason: "pairing key was rotated; ask the Hive operator for the new one",
      };
    }
    return { error: "unauthorized", reason: "pairing key not recognized" };
  }

  if (active.consumedAt) {
    recordPairingFailure(state, remote, now);
    return {
      error: "unauthorized",
      reason: "pairing key already used; ask the Hive operator to rotate",
    };
  }
  if (active.expiresAt.getTime() < now.getTime()) {
    recordPairingFailure(state, remote, now);
    return {
      error: "unauthorized",
      reason: "pairing key expired; ask the Hive operator to rotate",
    };
  }

  const beeId =
    findBeeIdByPublicKey(state, request.publicKey) ??
    `bee_${active.keyId.slice(3)}_${sha256Hex(request.publicKey).slice(0, 12)}`;
  active.consumedAt = now;
  active.consumedByBeeId = beeId;
  // Pairing keys are single-use: rotate immediately so the next Bee can't
  // reuse a key the operator already read aloud once.
  ensureActivePairingKey(state, now, true);
  // Successful pairing clears the rate-limit slate for this remote.
  state.pairingAttempts.delete(remote);
  return finalizeRegistration(state, request, beeId, now);
}

function finalizeRegistration(
  state: HiveServerState,
  request: BeeRegistrationRequest,
  beeId: string,
  now: Date,
): RegistrationSuccess {
  const session = generateSessionToken();
  const sessionExpiresAt = new Date(now.getTime() + SESSION_TTL_SECONDS * 1000);

  const existing = state.bees.get(beeId);
  state.bees.set(beeId, {
    beeId,
    beeName: request.beeName,
    publicKey: request.publicKey,
    daemonVersion: request.daemonVersion,
    status: "offline",
    activeJobs: 0,
    healthChecks: [],
    firstSeenAt: existing?.firstSeenAt ?? now.toISOString(),
    lastSeenAt: existing?.lastSeenAt ?? now.toISOString(),
    heartbeatCount: existing?.heartbeatCount ?? 0,
  });

  state.sessions.set(session.tokenHash, {
    sessionId: session.sessionId,
    beeId,
    tokenHash: session.tokenHash,
    expiresAt: sessionExpiresAt,
    createdAt: now,
  });

  return {
    type: "bee.registration.response",
    beeId,
    sessionToken: session.rawToken,
    sessionExpiresAt: sessionExpiresAt.toISOString(),
    acceptedAt: now.toISOString(),
  };
}

function checkPairingLockout(
  state: HiveServerState,
  remote: string,
  now: Date,
): RegisterError | undefined {
  const record = state.pairingAttempts.get(remote);
  if (!record) return undefined;
  if (record.lockoutUntil && record.lockoutUntil > now.getTime()) {
    const seconds = Math.max(1, Math.ceil((record.lockoutUntil - now.getTime()) / 1000));
    return {
      error: "rate_limited",
      reason: `too many pairing attempts; retry in ${seconds}s`,
    };
  }
  // Slide the window forward if it's stale.
  if (now.getTime() - record.windowStart > PAIRING_FAILURE_WINDOW_MS) {
    record.windowStart = now.getTime();
    record.recentFailures = 0;
    delete record.lockoutUntil;
  }
  return undefined;
}

function recordPairingFailure(state: HiveServerState, remote: string, now: Date): void {
  const existing = state.pairingAttempts.get(remote);
  if (!existing || now.getTime() - existing.windowStart > PAIRING_FAILURE_WINDOW_MS) {
    state.pairingAttempts.set(remote, {
      recentFailures: 1,
      windowStart: now.getTime(),
    });
    return;
  }
  existing.recentFailures += 1;
  if (existing.recentFailures >= PAIRING_FAILURE_LIMIT_PER_REMOTE) {
    existing.lockoutUntil = now.getTime() + PAIRING_LOCKOUT_MS;
  }
}

function remoteAddress(request: IncomingMessage): string {
  return request.socket.remoteAddress ?? "unknown";
}

type AuthOutcome = { ok: true } | { ok: false; reason: string };

function authenticateHeartbeat(
  request: IncomingMessage,
  rawBody: Buffer,
  heartbeat: BeeHeartbeat,
  state: HiveServerState,
  authRequired: boolean,
): AuthOutcome {
  // If auth is not required AND no auth headers were provided, accept.
  // (This is the v0.0.x dev-mode behaviour. Set HIVEPLANE_AUTH_REQUIRED=true
  // for production.)
  const sigHeader = headerString(request, "x-bee-signature");
  const bearer = extractBearer(request);
  const hasAuthHeaders = sigHeader !== undefined || !("error" in bearer);

  if (!authRequired && !hasAuthHeaders) {
    return { ok: true };
  }

  // If headers ARE present, verify them — even when auth isn't strictly
  // required — so a misconfigured Bee fails loud rather than silently.
  if (hasAuthHeaders || authRequired) {
    if ("error" in bearer) {
      return { ok: false, reason: bearer.error };
    }
    if (!looksLikeSessionToken(bearer.token)) {
      return { ok: false, reason: "session token shape invalid" };
    }
    const session = state.sessions.get(sha256Hex(bearer.token));
    if (!session) {
      return { ok: false, reason: "session not recognized" };
    }
    if (session.expiresAt.getTime() < Date.now()) {
      return { ok: false, reason: "session expired" };
    }
    if (session.beeId !== heartbeat.beeId) {
      return { ok: false, reason: "session does not match heartbeat beeId" };
    }
    if (!sigHeader) {
      return { ok: false, reason: "missing X-Bee-Signature header" };
    }
    const bee = state.bees.get(heartbeat.beeId);
    if (!bee?.publicKey) {
      return { ok: false, reason: "no public key on file for bee" };
    }
    if (!verifyBeeSignature(bee.publicKey, rawBody, sigHeader)) {
      return { ok: false, reason: "signature did not verify" };
    }
  }
  return { ok: true };
}

function authenticateBee(
  request: IncomingMessage,
  rawBody: Buffer,
  expectedBeeId: string,
  state: HiveServerState,
  authRequired: boolean,
): AuthOutcome {
  const sigHeader = headerString(request, "x-bee-signature");
  const bearer = extractBearer(request);
  const hasAuthHeaders = sigHeader !== undefined || !("error" in bearer);

  // Job event/complete posts are bee→hive too; in dev mode we accept
  // unauthenticated traffic but still verify partial auth loud rather than silent.
  if (!authRequired && !hasAuthHeaders) return { ok: true };

  if ("error" in bearer) return { ok: false, reason: bearer.error };
  if (!looksLikeSessionToken(bearer.token)) {
    return { ok: false, reason: "session token shape invalid" };
  }
  const session = state.sessions.get(sha256Hex(bearer.token));
  if (!session) return { ok: false, reason: "session not recognized" };
  if (session.expiresAt.getTime() < Date.now()) return { ok: false, reason: "session expired" };
  if (session.beeId !== expectedBeeId) {
    return { ok: false, reason: "session does not match request beeId" };
  }
  if (!sigHeader) return { ok: false, reason: "missing X-Bee-Signature header" };
  const bee = state.bees.get(expectedBeeId);
  if (!bee?.publicKey) return { ok: false, reason: "no public key on file for bee" };
  if (!verifyBeeSignature(bee.publicKey, rawBody, sigHeader)) {
    return { ok: false, reason: "signature did not verify" };
  }
  return { ok: true };
}

function serializeJob(job: JobRecord): Record<string, unknown> {
  return {
    id: job.id,
    beeId: job.beeId,
    type: job.type,
    status: job.status,
    payload: job.payload,
    ...(job.timeoutSeconds !== undefined ? { timeoutSeconds: job.timeoutSeconds } : {}),
    createdAt: job.createdAt.toISOString(),
    ...(job.assignedAt ? { assignedAt: job.assignedAt.toISOString() } : {}),
    ...(job.completedAt ? { completedAt: job.completedAt.toISOString() } : {}),
    eventCount: job.events.length,
    events: job.events,
    ...(job.exitCode !== undefined ? { exitCode: job.exitCode } : {}),
    ...(job.output ? { output: job.output } : {}),
    ...(job.error ? { error: job.error } : {}),
  };
}

function serializeBees(state: HiveServerState, now: Date): HiveBeeRecord[] {
  return [...state.bees.values()].map((bee) => {
    const lastSeenMs = new Date(bee.lastSeenAt).getTime();
    if (Number.isFinite(lastSeenMs) && now.getTime() - lastSeenMs > OFFLINE_AFTER_MS) {
      return { ...bee, status: "offline" };
    }
    return bee;
  });
}

function headerString(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name];
  if (Array.isArray(value)) return value[0];
  return value;
}

function ensureType(body: unknown, expected: string): unknown {
  if (body && typeof body === "object" && !("type" in body)) {
    return { ...(body as object), type: expected };
  }
  return body;
}

async function readJson(request: IncomingMessage): Promise<{ body: unknown; raw: Buffer }> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  const raw = Buffer.concat(chunks);
  if (raw.length === 0) return { body: {}, raw };
  return { body: JSON.parse(raw.toString("utf8")), raw };
}

function sendJson(response: ServerResponse, statusCode: number, payload: unknown): void {
  response.writeHead(statusCode, { "content-type": "application/json" });
  response.end(`${JSON.stringify(payload, null, 2)}\n`);
}
