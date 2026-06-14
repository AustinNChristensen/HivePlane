import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
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
  RescueHeartbeatSchema,
  type BeeHeartbeat,
  type BeeCapabilities,
  type BeeRegistrationRequest,
  type BeePermissions,
  type BootstrapTokenCreateRequest,
  type JobType,
  type JobStatus,
  type RescueHeartbeat,
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
  approveJob,
  cancelJob,
  claimPendingJobs,
  completeJob,
  CreateJobRequestSchema,
  createJob,
  createJobsState,
  denyJob,
  findJob,
  listJobs,
  requireApproval,
  type JobRecord,
  type JobsState,
} from "./jobs.js";
import { z } from "zod";

export type HiveBeeRecord = {
  beeId: string;
  beeName?: string;
  publicKey?: string;
  labels?: Record<string, string>;
  daemonVersion: string;
  status: BeeHeartbeat["status"];
  operationalState?: BeeOperationalState;
  profile: BeeDeviceProfile;
  activeJobs: number;
  capabilities?: BeeCapabilities;
  permissions?: BeePermissions;
  healthChecks: BeeHeartbeat["healthChecks"];
  rescue?: {
    status: RescueHeartbeat["status"] | "offline";
    rescueVersion: string;
    capabilities: RescueHeartbeat["capabilities"];
    lastSeenAt: string;
    heartbeatCount: number;
  };
  firstSeenAt: string;
  lastSeenAt: string;
  heartbeatCount: number;
};

export type BeeAvailabilityClass = "always_on" | "intermittent" | "ephemeral" | "critical";
export type BeeOperationalState =
  | "healthy"
  | "expected_offline"
  | "stale_watching"
  | "degraded"
  | "recovering"
  | "needs_approval"
  | "unresolved_incident";

export type BeeDeviceProfile = {
  availabilityClass: BeeAvailabilityClass;
  offlineGraceSeconds: number;
  expectedWindows: string[];
  criticalServices: string[];
  activeJobPolicy: "watch" | "escalate";
  autoRepairWhenOnline: boolean;
};

export type IncidentStatus = "open" | "recovering" | "needs_approval" | "resolved" | "unresolved";
export type IncidentSeverity = "info" | "warning" | "critical";

export type IncidentAttempt = {
  jobId: string;
  action: JobType;
  queuedAt: string;
  completedAt?: string;
  status?: JobStatus;
};

export type IncidentVerification = {
  jobId: string;
  queuedAt: string;
  completedAt?: string;
  status?: JobStatus;
};

export type IncidentNotification = {
  id: string;
  status: Extract<IncidentStatus, "needs_approval" | "unresolved">;
  queuedAt: string;
  message: string;
  deliveryStatus: "queued" | "delivering" | "sent" | "failed";
  deliveryChannel?: string;
  deliveryAttempts: number;
  lastAttemptAt?: string;
  deliveredAt?: string;
  lastError?: string;
};

export type IncidentRecord = {
  id: string;
  beeId: string;
  kind: string;
  status: IncidentStatus;
  severity: IncidentSeverity;
  summary: string;
  detectedAt: string;
  updatedAt: string;
  resolvedAt?: string;
  nextAction?: JobType;
  attempts: IncidentAttempt[];
  verification?: IncidentVerification;
  notifications: IncidentNotification[];
  lastDiagnosis?: string;
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
  /** Incidents keyed by deterministic bee/kind IDs. */
  incidents: Map<string, IncidentRecord>;
  /** Hive-level tasks assigned to Bees as sub-agent work. */
  tasks: Map<string, HiveTaskRecord>;
};

type DeviceProfilePatchResult =
  | { profile: BeeDeviceProfile; warnings: string[] }
  | { error: string; reason: string };

export type HiveTaskStatus =
  | "queued"
  | "assigned"
  | "running"
  | "succeeded"
  | "failed"
  | "blocked"
  | "cancelled";

export type HiveTaskRequirements = {
  runtimes: string[];
  tools: string[];
  models: string[];
};

export type HiveTaskRecord = {
  id: string;
  title: string;
  instructions: string;
  requestedBy?: string;
  preferredBeeId?: string;
  requirements: HiveTaskRequirements;
  status: HiveTaskStatus;
  assignedBeeId?: string;
  jobId?: string;
  createdAt: string;
  updatedAt: string;
  lastError?: string;
};

export type IncidentNotificationPayload = {
  incident: IncidentRecord;
  notification: IncidentNotification;
  bee?: HiveBeeRecord;
};

export type IncidentNotifier = {
  channel: string;
  deliver: (payload: IncidentNotificationPayload) => Promise<void>;
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
  /** Optional sink for unresolved / approval-needed incident alerts. */
  incidentNotifier?: IncidentNotifier | null;
};

export function createHiveServerState(): HiveServerState {
  return {
    bees: new Map(),
    bootstrapTokens: new Map(),
    sessions: new Map(),
    retiredPairingKeys: [],
    pairingAttempts: new Map(),
    jobsState: createJobsState(),
    incidents: new Map(),
    tasks: new Map(),
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
  const capabilities = heartbeat.capabilities ?? existing?.capabilities;
  const permissions = heartbeat.permissions ?? existing?.permissions;
  const record: HiveBeeRecord = {
    beeId: heartbeat.beeId,
    ...(existing?.beeName ? { beeName: existing.beeName } : {}),
    ...(existing?.publicKey ? { publicKey: existing.publicKey } : {}),
    ...(existing?.labels ? { labels: existing.labels } : {}),
    daemonVersion: heartbeat.daemonVersion,
    status: heartbeat.status,
    profile: existing?.profile ?? defaultDeviceProfile(existing?.labels),
    activeJobs: heartbeat.activeJobs,
    healthChecks: heartbeat.healthChecks,
    firstSeenAt: existing?.firstSeenAt ?? timestamp,
    lastSeenAt: timestamp,
    heartbeatCount: (existing?.heartbeatCount ?? 0) + 1,
  };
  if (capabilities) record.capabilities = capabilities;
  if (permissions) record.permissions = permissions;
  if (existing?.rescue) record.rescue = existing.rescue;

  state.bees.set(heartbeat.beeId, record);
  return record;
}

export function upsertRescueHeartbeat(
  state: HiveServerState,
  heartbeat: RescueHeartbeat,
  now = new Date(),
): HiveBeeRecord {
  const existing = state.bees.get(heartbeat.beeId);
  const timestamp = heartbeat.timestamp || now.toISOString();
  const record: HiveBeeRecord = existing
    ? { ...existing }
    : {
        beeId: heartbeat.beeId,
        daemonVersion: "unknown",
        status: "offline",
        profile: defaultDeviceProfile(),
        activeJobs: 0,
        healthChecks: [],
        firstSeenAt: timestamp,
        lastSeenAt: timestamp,
        heartbeatCount: 0,
      };

  record.rescue = {
    status: heartbeat.status,
    rescueVersion: heartbeat.rescueVersion,
    capabilities: heartbeat.capabilities,
    lastSeenAt: timestamp,
    heartbeatCount: (existing?.rescue?.heartbeatCount ?? 0) + 1,
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
const INCIDENT_ATTEMPT_COOLDOWN_MS = 5 * 60 * 1000;
const INCIDENT_MAX_ATTEMPTS = 3;
const INCIDENT_NOTIFICATION_RETRY_COOLDOWN_MS = 5 * 60 * 1000;
const INCIDENT_NOTIFICATION_MAX_ATTEMPTS = 5;
const TaskRequirementsSchema = z
  .object({
    runtimes: z.array(z.string().min(1)).default([]),
    tools: z.array(z.string().min(1)).default([]),
    models: z.array(z.string().min(1)).default([]),
  })
  .default({});
const CreateHiveTaskRequestSchema = z.object({
  title: z.string().min(1).max(120),
  instructions: z.string().min(1).max(8000),
  requestedBy: z.string().min(1).max(120).optional(),
  preferredBeeId: z.string().min(1).optional(),
  requirements: TaskRequirementsSchema,
});

const HIVE_VERSION = "0.0.7";
const RESCUE_JOB_TYPES: readonly JobType[] = [
  "restart_bee",
  "update_bee",
  "collect_bee_logs",
  "diagnose_incident",
  "restart_openclaw_gateway",
  "restart_hermes_gateway",
  "repair_imessage_bridge",
];
const AUTO_APPROVED_JOB_TYPES = new Set<JobType>([
  "run_healthcheck",
  "openclaw_status",
  "ollama_status",
  "ollama_list_models",
  "diagnose_incident",
  "restart_bee",
  "collect_bee_logs",
  "restart_openclaw_gateway",
  "restart_hermes_gateway",
]);
const HEALTHCHECK_RUNBOOKS: Record<string, JobType> = {
  "openclaw-gateway": "restart_openclaw_gateway",
  "hermes-gateway": "restart_hermes_gateway",
  "hiveplane-bee": "restart_bee",
};

export function createHiveServer(options: CreateHiveServerOptions = {}) {
  const state = options.state ?? createHiveServerState();
  const now = options.now ?? (() => new Date());
  const installScriptsDir = options.installScriptsDir ?? defaultInstallScriptsDir();
  const publicDir = options.publicDir ?? defaultPublicDir();
  const adminToken = options.adminToken ?? getRequiredAdminToken();
  const authRequired = options.authRequired ?? isAuthRequired();
  // No-op when persistence isn't attached (tests, --no-persist, etc.).
  const markDirty = options.onMutation ?? (() => {});
  const incidentNotifier = options.incidentNotifier ?? createIncidentNotifierFromEnv();
  const deliverPendingIncidentNotifications = async (current: Date): Promise<void> => {
    if (!incidentNotifier) return;
    await deliverIncidentNotifications(state, incidentNotifier, current);
  };
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
        const current = now();
        return sendJson(response, 200, {
          bees: serializeBees(state, current),
          incidents: serializeIncidents(state, current),
        });
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

      const patchBeeProfileMatch = /^\/api\/bees\/([^/]+)\/profile$/.exec(url.pathname);
      if (request.method === "PATCH" && patchBeeProfileMatch) {
        if (!checkAdmin(request, response, adminToken)) return;
        const beeId = decodeURIComponent(patchBeeProfileMatch[1] ?? "");
        const bee = state.bees.get(beeId);
        if (!bee) {
          return sendJson(response, 404, { error: "not_found", reason: "bee not registered" });
        }
        const { body } = await readJson(request);
        const parsed = parseDeviceProfilePatch(body, bee.profile);
        if ("error" in parsed) {
          return sendJson(response, 400, parsed);
        }
        bee.profile = parsed.profile;
        markDirty();
        return sendJson(response, 200, {
          bee: serializeBee(bee, now()),
          warnings: parsed.warnings,
        });
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
        const current = now();
        evaluateBeeAutomation(state, heartbeat.beeId, current);
        scheduleOpenHiveTasks(state, current);
        await deliverPendingIncidentNotifications(current);
        // Hand back any pending jobs and mark them as assigned.
        const jobs = claimPendingJobs(state.jobsState, heartbeat.beeId, current, {
          excludeTypes: RESCUE_JOB_TYPES,
        });
        markDirty();
        return sendJson(response, 200, { accepted: true, bee, jobs });
      }

      if (request.method === "POST" && url.pathname === "/api/rescue/heartbeat") {
        const { body, raw } = await readJson(request);
        const parsed = RescueHeartbeatSchema.safeParse(body);
        if (!parsed.success) {
          return sendJson(response, 400, {
            error: "bad_request",
            message: parsed.error.message,
          });
        }
        const heartbeat = parsed.data;
        const authResult = authenticateBee(request, raw, heartbeat.beeId, state, authRequired);
        if (!authResult.ok) {
          return sendJson(response, 401, { error: "unauthorized", reason: authResult.reason });
        }
        const current = now();
        const bee = upsertRescueHeartbeat(state, heartbeat, current);
        evaluateBeeAutomation(state, heartbeat.beeId, current);
        scheduleOpenHiveTasks(state, current);
        await deliverPendingIncidentNotifications(current);
        const jobs = claimPendingJobs(state.jobsState, heartbeat.beeId, current, {
          types: RESCUE_JOB_TYPES,
        });
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
        if (jobNeedsApproval(job)) requireApproval(job);
        markDirty();
        return sendJson(response, 200, { job: serializeJob(job) });
      }

      const approveJobMatch = /^\/api\/jobs\/([^/]+)\/approve$/.exec(url.pathname);
      if (request.method === "POST" && approveJobMatch) {
        if (!checkAdmin(request, response, adminToken)) return;
        const jobId = decodeURIComponent(approveJobMatch[1] ?? "");
        const job = approveJob(state.jobsState, jobId);
        if (!job) return sendJson(response, 404, { error: "not_found" });
        markDirty();
        return sendJson(response, 200, { job: serializeJob(job) });
      }

      const denyJobMatch = /^\/api\/jobs\/([^/]+)\/deny$/.exec(url.pathname);
      if (request.method === "POST" && denyJobMatch) {
        if (!checkAdmin(request, response, adminToken)) return;
        const jobId = decodeURIComponent(denyJobMatch[1] ?? "");
        const job = denyJob(state.jobsState, jobId, now());
        if (!job) return sendJson(response, 404, { error: "not_found" });
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
        const updated = appendEvents(state.jobsState, jobId, parsed.data.events);
        const current = now();
        if (updated) updateHiveTaskFromJob(state, updated, current);
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
        const current = now();
        const updated = completeJob(state.jobsState, jobId, parsed.data, current);
        if (updated) onJobCompleted(state, updated, current);
        if (updated) updateHiveTaskFromJob(state, updated, current);
        await deliverPendingIncidentNotifications(current);
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

      if (request.method === "GET" && url.pathname === "/api/tasks") {
        if (!checkAdmin(request, response, adminToken)) return;
        return sendJson(response, 200, { tasks: serializeTasks(state) });
      }

      const getTaskMatch = /^\/api\/tasks\/([^/]+)$/.exec(url.pathname);
      if (request.method === "GET" && getTaskMatch) {
        if (!checkAdmin(request, response, adminToken)) return;
        const taskId = decodeURIComponent(getTaskMatch[1] ?? "");
        const task = state.tasks.get(taskId);
        if (!task) return sendJson(response, 404, { error: "not_found" });
        const job = task.jobId ? findJob(state.jobsState, task.jobId) : null;
        return sendJson(response, 200, {
          task: serializeTask(task),
          ...(job ? { job: serializeJob(job) } : {}),
        });
      }

      const retryTaskMatch = /^\/api\/tasks\/([^/]+)\/retry$/.exec(url.pathname);
      if (request.method === "POST" && retryTaskMatch) {
        if (!checkAdmin(request, response, adminToken)) return;
        const taskId = decodeURIComponent(retryTaskMatch[1] ?? "");
        const task = state.tasks.get(taskId);
        if (!task) return sendJson(response, 404, { error: "not_found" });
        if (task.status === "assigned" || task.status === "running" || task.status === "queued") {
          return sendJson(response, 409, {
            error: "task_not_retryable",
            reason: `Task is currently ${task.status}.`,
          });
        }
        const current = now();
        task.status = "queued";
        task.updatedAt = current.toISOString();
        delete task.assignedBeeId;
        delete task.jobId;
        delete task.lastError;
        scheduleHiveTask(state, task, current);
        markDirty();
        return sendJson(response, 200, { task: serializeTask(task) });
      }

      const cancelTaskMatch = /^\/api\/tasks\/([^/]+)\/cancel$/.exec(url.pathname);
      if (request.method === "POST" && cancelTaskMatch) {
        if (!checkAdmin(request, response, adminToken)) return;
        const taskId = decodeURIComponent(cancelTaskMatch[1] ?? "");
        const task = state.tasks.get(taskId);
        if (!task) return sendJson(response, 404, { error: "not_found" });
        if (["succeeded", "failed", "cancelled"].includes(task.status)) {
          return sendJson(response, 409, {
            error: "task_not_cancellable",
            reason: `Task is already ${task.status}.`,
          });
        }
        const current = now();
        if (task.jobId) {
          const job = cancelJob(state.jobsState, task.jobId, current);
          if (job) updateHiveTaskFromJob(state, job, current);
        }
        task.status = "cancelled";
        task.updatedAt = current.toISOString();
        task.lastError = "Cancelled by Hive admin.";
        markDirty();
        return sendJson(response, 200, { task: serializeTask(task) });
      }

      if (request.method === "POST" && url.pathname === "/api/tasks") {
        if (!checkAdmin(request, response, adminToken)) return;
        const { body } = await readJson(request);
        const parsed = CreateHiveTaskRequestSchema.safeParse(body);
        if (!parsed.success) {
          return sendJson(response, 400, {
            error: "bad_request",
            message: parsed.error.message,
          });
        }
        const current = now();
        const task = createHiveTask(state, parsed.data, current);
        scheduleHiveTask(state, task, current);
        markDirty();
        return sendJson(response, 200, { task: serializeTask(task) });
      }

      if (request.method === "GET" && url.pathname === "/api/incidents") {
        if (!checkAdmin(request, response, adminToken)) return;
        return sendJson(response, 200, { incidents: serializeIncidents(state, now()) });
      }

      if (request.method === "POST" && url.pathname === "/api/incidents/notifications/deliver") {
        if (!checkAdmin(request, response, adminToken)) return;
        if (!incidentNotifier) {
          return sendJson(response, 503, {
            error: "notification_delivery_disabled",
            reason:
              "Set HIVEPLANE_INCIDENT_WEBHOOK_URL or HIVEPLANE_INCIDENT_NOTIFY_COMMAND to enable delivery.",
          });
        }
        const current = now();
        await deliverIncidentNotifications(state, incidentNotifier, current, { force: true });
        markDirty();
        return sendJson(response, 200, { incidents: serializeIncidents(state, current) });
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
  const labels = request.labels;
  state.bees.set(beeId, {
    beeId,
    beeName: request.beeName,
    publicKey: request.publicKey,
    labels,
    daemonVersion: request.daemonVersion,
    status: "offline",
    profile: existing?.profile ?? defaultDeviceProfile(labels, request.beeName),
    activeJobs: 0,
    capabilities: request.capabilities,
    ...(existing?.permissions ? { permissions: existing.permissions } : {}),
    ...(existing?.rescue ? { rescue: existing.rescue } : {}),
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

function jobNeedsApproval(job: JobRecord): boolean {
  if (AUTO_APPROVED_JOB_TYPES.has(job.type)) return false;
  if (job.type === "run_command") {
    const command = typeof job.payload.command === "string" ? job.payload.command : "";
    const basename = command.trim().split("/").pop() ?? command.trim();
    return !["hostname", "df", "uptime"].includes(basename);
  }
  return true;
}

function serializeBees(state: HiveServerState, now: Date): HiveBeeRecord[] {
  return [...state.bees.values()].map((bee) => serializeBee(bee, now, state));
}

function serializeBee(bee: HiveBeeRecord, now: Date, state?: HiveServerState): HiveBeeRecord {
  const rescue = bee.rescue
    ? {
        ...bee.rescue,
        status:
          now.getTime() - new Date(bee.rescue.lastSeenAt).getTime() > OFFLINE_AFTER_MS
            ? "offline"
            : bee.rescue.status,
      }
    : undefined;
  const lastSeenMs = new Date(bee.lastSeenAt).getTime();
  const offlineAfterMs = beeOfflineAfterMs(bee);
  const status =
    Number.isFinite(lastSeenMs) && now.getTime() - lastSeenMs > offlineAfterMs
      ? "offline"
      : bee.status;
  const withStatus = rescue ? { ...bee, status, rescue } : { ...bee, status };
  return { ...withStatus, operationalState: computeOperationalState(withStatus, now, state) };
}

function beeOfflineAfterMs(bee: HiveBeeRecord): number {
  return Math.min(OFFLINE_AFTER_MS, bee.profile.offlineGraceSeconds * 1000);
}

function serializeIncidents(state: HiveServerState, _now: Date): IncidentRecord[] {
  return [...state.incidents.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

function serializeTasks(state: HiveServerState): HiveTaskRecord[] {
  return [...state.tasks.values()]
    .map(serializeTask)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

function serializeTask(task: HiveTaskRecord): HiveTaskRecord {
  return { ...task, requirements: { ...task.requirements } };
}

function generateTaskId(): string {
  return `task_${randomBytes(8).toString("hex")}`;
}

function normalizeTaskRequirements(requirements: HiveTaskRequirements): HiveTaskRequirements {
  return {
    runtimes: dedupeStrings(requirements.runtimes),
    tools: dedupeStrings(requirements.tools),
    models: dedupeStrings(requirements.models),
  };
}

function dedupeStrings(values: string[]): string[] {
  const out: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (trimmed && !out.includes(trimmed)) out.push(trimmed);
  }
  return out;
}

function createHiveTask(
  state: HiveServerState,
  request: z.infer<typeof CreateHiveTaskRequestSchema>,
  now: Date,
): HiveTaskRecord {
  const task: HiveTaskRecord = {
    id: generateTaskId(),
    title: request.title.trim(),
    instructions: request.instructions.trim(),
    ...(request.requestedBy ? { requestedBy: request.requestedBy.trim() } : {}),
    ...(request.preferredBeeId ? { preferredBeeId: request.preferredBeeId } : {}),
    requirements: normalizeTaskRequirements(request.requirements),
    status: "queued",
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  };
  state.tasks.set(task.id, task);
  return task;
}

function scheduleOpenHiveTasks(state: HiveServerState, now: Date): void {
  for (const task of state.tasks.values()) {
    if (task.status === "queued" || task.status === "blocked") {
      scheduleHiveTask(state, task, now);
    }
  }
}

function scheduleHiveTask(state: HiveServerState, task: HiveTaskRecord, now: Date): void {
  if (task.status === "cancelled") return;
  if (task.jobId && state.jobsState.jobs.get(task.jobId)?.status !== "cancelled") return;
  const bee = selectBeeForTask(state, task, now);
  if (!bee) {
    task.status = "blocked";
    task.updatedAt = now.toISOString();
    task.lastError = "No healthy Bee currently matches the task requirements.";
    delete task.assignedBeeId;
    delete task.jobId;
    return;
  }

  const job = createJob(
    state.jobsState,
    bee.beeId,
    {
      type: "agent_task",
      payload: {
        taskId: task.id,
        title: task.title,
        instructions: task.instructions,
        requestedBy: task.requestedBy ?? "hive",
        requirements: task.requirements,
      },
    },
    now,
  );
  task.status = "assigned";
  task.assignedBeeId = bee.beeId;
  task.jobId = job.id;
  task.updatedAt = now.toISOString();
  delete task.lastError;
}

function selectBeeForTask(
  state: HiveServerState,
  task: HiveTaskRecord,
  now: Date,
): HiveBeeRecord | null {
  const candidates = [...state.bees.values()]
    .map((bee) => serializeBee(bee, now, state))
    .filter((bee) => {
      if (task.preferredBeeId && bee.beeId !== task.preferredBeeId) return false;
      if (bee.status !== "online") return false;
      if (bee.operationalState !== "healthy") return false;
      if (!matchesTaskRequirements(bee, task.requirements)) return false;
      return true;
    })
    .sort((a, b) => (a.activeJobs ?? 0) - (b.activeJobs ?? 0));
  return candidates[0] ?? null;
}

function matchesTaskRequirements(bee: HiveBeeRecord, requirements: HiveTaskRequirements): boolean {
  if (
    requirements.runtimes.length === 0 &&
    requirements.tools.length === 0 &&
    requirements.models.length === 0
  ) {
    return true;
  }
  const capabilities = bee.capabilities;
  if (!capabilities) return false;
  return (
    requirements.runtimes.every((runtime) => capabilities.runtimes.includes(runtime)) &&
    requirements.tools.every((tool) => capabilities.tools.includes(tool)) &&
    requirements.models.every((model) => capabilities.models.includes(model))
  );
}

function updateHiveTaskFromJob(state: HiveServerState, job: JobRecord, now: Date): void {
  const taskId = typeof job.payload.taskId === "string" ? job.payload.taskId : "";
  if (!taskId) return;
  const task = state.tasks.get(taskId);
  if (!task) return;
  if (job.status === "succeeded") {
    task.status = "succeeded";
    delete task.lastError;
  } else if (job.status === "failed" || job.status === "timed_out" || job.status === "cancelled") {
    task.status = job.status === "cancelled" ? "cancelled" : "failed";
    task.lastError =
      typeof job.error?.message === "string"
        ? job.error.message
        : `${job.type} ended with status ${job.status}`;
  } else if (job.status === "running" || job.status === "assigned") {
    task.status = "running";
  }
  task.updatedAt = now.toISOString();
}

function defaultDeviceProfile(labels: Record<string, string> = {}, beeName = ""): BeeDeviceProfile {
  const rawClass =
    labels.availability_class ??
    labels.availabilityClass ??
    labels.availability ??
    inferAvailabilityClass(beeName);
  const availabilityClass = parseAvailabilityClass(rawClass) ?? "always_on";
  const offlineGraceSeconds =
    parsePositiveInt(labels.offline_grace_seconds ?? labels.offlineGraceSeconds) ??
    defaultOfflineGraceSeconds(availabilityClass);
  const criticalServices = parseCsv(labels.critical_services ?? labels.criticalServices);

  return {
    availabilityClass,
    offlineGraceSeconds,
    expectedWindows: parseCsv(labels.expected_windows ?? labels.expectedWindows),
    criticalServices,
    activeJobPolicy: labels.active_job_policy === "watch" ? "watch" : "escalate",
    autoRepairWhenOnline: labels.auto_repair_when_online !== "false",
  };
}

function parseDeviceProfilePatch(
  body: unknown,
  existing: BeeDeviceProfile,
): DeviceProfilePatchResult {
  if (!body || typeof body !== "object") {
    return { error: "bad_request", reason: "profile patch must be a JSON object" };
  }
  const input = body as Record<string, unknown>;
  let availabilityClass = existing.availabilityClass;
  if (input.availabilityClass !== undefined) {
    if (typeof input.availabilityClass !== "string") {
      return { error: "bad_request", reason: "availabilityClass must be a string" };
    }
    const parsed = parseAvailabilityClass(input.availabilityClass);
    if (!parsed) return { error: "bad_request", reason: "availabilityClass is invalid" };
    availabilityClass = parsed;
  }

  let offlineGraceSeconds = existing.offlineGraceSeconds;
  if (input.offlineGraceSeconds !== undefined) {
    if (
      typeof input.offlineGraceSeconds !== "number" ||
      !Number.isInteger(input.offlineGraceSeconds) ||
      input.offlineGraceSeconds < 30 ||
      input.offlineGraceSeconds > 7 * 24 * 60 * 60
    ) {
      return {
        error: "bad_request",
        reason: "offlineGraceSeconds must be an integer from 30 seconds to 7 days",
      };
    }
    offlineGraceSeconds = input.offlineGraceSeconds;
  }

  const expectedWindows =
    input.expectedWindows !== undefined
      ? parseProfileStringList(input.expectedWindows, "expectedWindows")
      : { values: existing.expectedWindows };
  if ("error" in expectedWindows) return expectedWindows;

  const criticalServices =
    input.criticalServices !== undefined
      ? parseProfileStringList(input.criticalServices, "criticalServices")
      : { values: existing.criticalServices };
  if ("error" in criticalServices) return criticalServices;

  let activeJobPolicy = existing.activeJobPolicy;
  if (input.activeJobPolicy !== undefined) {
    if (input.activeJobPolicy !== "watch" && input.activeJobPolicy !== "escalate") {
      return { error: "bad_request", reason: "activeJobPolicy must be watch or escalate" };
    }
    activeJobPolicy = input.activeJobPolicy;
  }

  if (input.autoRepairWhenOnline !== undefined && typeof input.autoRepairWhenOnline !== "boolean") {
    return { error: "bad_request", reason: "autoRepairWhenOnline must be a boolean" };
  }

  const profile = {
    availabilityClass,
    offlineGraceSeconds,
    expectedWindows: expectedWindows.values,
    criticalServices: criticalServices.values,
    activeJobPolicy,
    autoRepairWhenOnline:
      typeof input.autoRepairWhenOnline === "boolean"
        ? input.autoRepairWhenOnline
        : existing.autoRepairWhenOnline,
  };
  return { profile, warnings: getDeviceProfileWarnings(profile) };
}

function parseProfileStringList(
  value: unknown,
  field: "expectedWindows" | "criticalServices",
): { values: string[] } | { error: string; reason: string } {
  if (!Array.isArray(value)) {
    return { error: "bad_request", reason: `${field} must be an array of strings` };
  }
  const values: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") {
      return { error: "bad_request", reason: `${field} must contain only strings` };
    }
    const trimmed = item.trim();
    if (!trimmed) continue;
    if (trimmed.length > 80) {
      return { error: "bad_request", reason: `${field} entries must be 80 characters or less` };
    }
    if (!values.includes(trimmed)) values.push(trimmed);
  }
  if (values.length > 50) {
    return { error: "bad_request", reason: `${field} can contain at most 50 entries` };
  }
  return { values };
}

function getDeviceProfileWarnings(profile: BeeDeviceProfile): string[] {
  const warnings: string[] = [];
  if (
    (profile.availabilityClass === "critical" || profile.availabilityClass === "always_on") &&
    profile.offlineGraceSeconds > 10 * 60
  ) {
    warnings.push("Always-on and critical Bees usually need a grace window under 10 minutes.");
  }
  if (
    profile.availabilityClass === "critical" &&
    profile.offlineGraceSeconds > defaultOfflineGraceSeconds("critical")
  ) {
    warnings.push("Critical Bees default to a 60 second grace window.");
  }
  if (
    (profile.availabilityClass === "critical" || profile.availabilityClass === "always_on") &&
    !profile.autoRepairWhenOnline
  ) {
    warnings.push("Auto repair is disabled, so server-like Bees will alert instead of self-heal.");
  }
  if (profile.availabilityClass === "critical" && profile.criticalServices.length === 0) {
    warnings.push("Critical profiles are more useful when at least one critical service is set.");
  }
  if (
    (profile.availabilityClass === "intermittent" || profile.availabilityClass === "ephemeral") &&
    profile.activeJobPolicy === "watch"
  ) {
    warnings.push("Watch mode will not escalate quickly if this Bee disappears with active jobs.");
  }
  return warnings;
}

function parseAvailabilityClass(value: string | undefined): BeeAvailabilityClass | undefined {
  if (
    value === "always_on" ||
    value === "intermittent" ||
    value === "ephemeral" ||
    value === "critical"
  ) {
    return value;
  }
  return undefined;
}

function inferAvailabilityClass(beeName: string): BeeAvailabilityClass {
  return /macbook|laptop|mbp/i.test(beeName) ? "intermittent" : "always_on";
}

function defaultOfflineGraceSeconds(availabilityClass: BeeAvailabilityClass): number {
  if (availabilityClass === "critical") return 60;
  if (availabilityClass === "always_on") return 120;
  if (availabilityClass === "intermittent") return 12 * 60 * 60;
  return 24 * 60 * 60;
}

function parsePositiveInt(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function parseCsv(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

function computeOperationalState(
  bee: HiveBeeRecord,
  now: Date,
  state?: HiveServerState,
): BeeOperationalState {
  const activeIncident = state
    ? [...state.incidents.values()].find(
        (incident) =>
          incident.beeId === bee.beeId &&
          (incident.status === "open" ||
            incident.status === "recovering" ||
            incident.status === "needs_approval" ||
            incident.status === "unresolved"),
      )
    : undefined;
  if (activeIncident?.status === "recovering") return "recovering";
  if (activeIncident?.status === "needs_approval") return "needs_approval";
  if (activeIncident?.status === "unresolved") return "unresolved_incident";

  if (bee.status === "offline") {
    const staleMs = now.getTime() - new Date(bee.lastSeenAt).getTime();
    const graceMs = bee.profile.offlineGraceSeconds * 1000;
    if (bee.activeJobs > 0 && bee.profile.activeJobPolicy === "escalate") return "degraded";
    if (staleMs <= beeOfflineAfterMs(bee)) return "healthy";
    if (staleMs <= graceMs) return "expected_offline";
    return bee.profile.availabilityClass === "intermittent" ||
      bee.profile.availabilityClass === "ephemeral"
      ? "stale_watching"
      : "unresolved_incident";
  }

  if (bee.status === "degraded" || bee.healthChecks.some((check) => check.status === "failing")) {
    return "degraded";
  }
  return "healthy";
}

function evaluateBeeAutomation(state: HiveServerState, beeId: string, now: Date): void {
  const bee = serializeBee(state.bees.get(beeId)!, now);
  closeResolvedIncidents(state, bee, now);
  evaluateOfflineIncident(state, bee, now);
  evaluateHealthIncidents(state, bee, now);
}

function closeResolvedIncidents(state: HiveServerState, bee: HiveBeeRecord, now: Date): void {
  for (const incident of state.incidents.values()) {
    if (incident.beeId !== bee.beeId) continue;
    if (incident.status === "resolved") continue;
    if (!incidentHasSuccessfulVerification(incident)) continue;
    if (incident.kind === "bee_offline" && bee.status !== "offline") {
      resolveIncident(incident, now, "Bee heartbeat recovered after verification.");
      continue;
    }
    if (incident.kind.startsWith("health:")) {
      const checkName = incident.kind.slice("health:".length);
      const check = bee.healthChecks.find((candidate) => candidate.name === checkName);
      if (check?.status === "passing") {
        resolveIncident(incident, now, `${checkName} health check recovered after verification.`);
      }
    }
  }
}

function evaluateOfflineIncident(state: HiveServerState, bee: HiveBeeRecord, now: Date): void {
  if (bee.status !== "offline") return;

  const staleMs = now.getTime() - new Date(bee.lastSeenAt).getTime();
  const graceMs =
    bee.activeJobs > 0 && bee.profile.activeJobPolicy === "escalate"
      ? Math.min(5 * 60 * 1000, bee.profile.offlineGraceSeconds * 1000)
      : bee.profile.offlineGraceSeconds * 1000;
  if (staleMs <= graceMs) return;

  const incident = ensureIncident(state, {
    beeId: bee.beeId,
    kind: "bee_offline",
    severity:
      bee.profile.availabilityClass === "critical" || bee.profile.availabilityClass === "always_on"
        ? "critical"
        : "warning",
    summary: `${bee.beeName ?? bee.beeId} is offline outside its expected availability policy.`,
    now,
  });
  incident.lastDiagnosis =
    "Hive classified this as a Bee availability incident using the device profile, last heartbeat, active job count, and Rescue status.";

  if (bee.rescue?.status === "online") {
    queueAutoRecovery(state, incident, bee, "restart_bee", now);
  } else {
    markUnresolved(
      incident,
      now,
      "Rescue is not online, so HivePlane cannot safely repair this Bee automatically.",
    );
  }
}

function evaluateHealthIncidents(state: HiveServerState, bee: HiveBeeRecord, now: Date): void {
  if (bee.status === "offline") return;
  for (const check of bee.healthChecks) {
    if (check.status !== "failing") continue;
    const kind = `health:${check.name}`;
    const action = HEALTHCHECK_RUNBOOKS[check.name];
    const incident = ensureIncident(state, {
      beeId: bee.beeId,
      kind,
      severity: bee.profile.criticalServices.includes(check.name) ? "critical" : "warning",
      summary: `${bee.beeName ?? bee.beeId} has a failing ${check.name} health check.`,
      now,
    });
    incident.lastDiagnosis = `Hive classified ${check.name} as a failing service from the Bee health report. ${
      action ? `The safest known runbook is ${action}.` : "No safe automatic runbook is known yet."
    }`;
    if (!action) {
      if (bee.rescue?.status === "online") queueAiDiagnosis(state, incident, bee, now);
      markNeedsApproval(incident, now, "No allowlisted auto-repair action exists for this check.");
      continue;
    }
    if (bee.rescue?.status === "online") {
      queueAutoRecovery(state, incident, bee, action, now);
    } else {
      markUnresolved(
        incident,
        now,
        "Rescue is not online, so the known runbook cannot be executed automatically.",
      );
    }
  }
}

function ensureIncident(
  state: HiveServerState,
  input: {
    beeId: string;
    kind: string;
    severity: IncidentSeverity;
    summary: string;
    now: Date;
  },
): IncidentRecord {
  const id = `${input.beeId}:${input.kind}`;
  const existing = state.incidents.get(id);
  if (existing && existing.status !== "resolved") {
    existing.updatedAt = input.now.toISOString();
    existing.summary = input.summary;
    existing.severity = input.severity;
    return existing;
  }
  const incident: IncidentRecord = {
    id,
    beeId: input.beeId,
    kind: input.kind,
    status: "open",
    severity: input.severity,
    summary: input.summary,
    detectedAt: input.now.toISOString(),
    updatedAt: input.now.toISOString(),
    attempts: [],
    notifications: [],
  };
  state.incidents.set(id, incident);
  return incident;
}

function resolveIncident(incident: IncidentRecord, now: Date, diagnosis: string): void {
  incident.status = "resolved";
  incident.updatedAt = now.toISOString();
  incident.resolvedAt = now.toISOString();
  incident.lastDiagnosis = diagnosis;
  delete incident.nextAction;
}

function markNeedsApproval(incident: IncidentRecord, now: Date, diagnosis: string): void {
  incident.status = "needs_approval";
  incident.updatedAt = now.toISOString();
  incident.lastDiagnosis = diagnosis;
  queueIncidentNotification(incident, "needs_approval", now);
}

function markUnresolved(incident: IncidentRecord, now: Date, diagnosis: string): void {
  incident.status = "unresolved";
  incident.updatedAt = now.toISOString();
  incident.lastDiagnosis = diagnosis;
  queueIncidentNotification(incident, "unresolved", now);
}

function queueAutoRecovery(
  state: HiveServerState,
  incident: IncidentRecord,
  bee: HiveBeeRecord,
  action: JobType,
  now: Date,
): void {
  if (!bee.profile.autoRepairWhenOnline && bee.status !== "offline") {
    markNeedsApproval(incident, now, "Auto-repair is disabled for this Bee profile.");
    return;
  }
  if (!AUTO_APPROVED_JOB_TYPES.has(action)) {
    queueAiDiagnosis(state, incident, bee, now);
    incident.nextAction = action;
    markNeedsApproval(incident, now, `${action} requires operator approval.`);
    return;
  }
  if (incident.attempts.length >= INCIDENT_MAX_ATTEMPTS) {
    markUnresolved(incident, now, `${action} already reached the automatic retry limit.`);
    return;
  }
  const lastAttempt = incident.attempts.at(-1);
  if (
    lastAttempt &&
    now.getTime() - new Date(lastAttempt.queuedAt).getTime() < INCIDENT_ATTEMPT_COOLDOWN_MS
  ) {
    incident.status = "recovering";
    incident.updatedAt = now.toISOString();
    incident.nextAction = action;
    return;
  }
  if (hasActiveJob(state, bee.beeId, action)) {
    queueAiDiagnosis(state, incident, bee, now);
    incident.status = "recovering";
    incident.updatedAt = now.toISOString();
    incident.nextAction = action;
    return;
  }

  queueAiDiagnosis(state, incident, bee, now);
  const job = createJob(
    state.jobsState,
    bee.beeId,
    { type: action, payload: { incidentId: incident.id } },
    now,
  );
  incident.status = "recovering";
  incident.updatedAt = now.toISOString();
  incident.nextAction = action;
  incident.attempts.push({ jobId: job.id, action, queuedAt: now.toISOString() });
}

function onJobCompleted(state: HiveServerState, job: JobRecord, now: Date): void {
  const incidentId = typeof job.payload.incidentId === "string" ? job.payload.incidentId : "";
  if (!incidentId) return;
  const incident = state.incidents.get(incidentId);
  if (!incident || incident.status === "resolved") return;

  const attempt = incident.attempts.find((candidate) => candidate.jobId === job.id);
  if (attempt) {
    attempt.completedAt = now.toISOString();
    attempt.status = job.status;
  }

  if (incident.verification?.jobId === job.id) {
    incident.verification.completedAt = now.toISOString();
    incident.verification.status = job.status;
    incident.updatedAt = now.toISOString();
    if (job.status !== "succeeded") {
      markUnresolved(incident, now, "Post-repair verification job failed.");
    }
    return;
  }

  if (job.type === "diagnose_incident") {
    if (job.status === "succeeded") {
      updateIncidentFromAiDiagnosis(incident, job, now);
    }
    return;
  }

  if (job.type === "run_healthcheck") return;
  if (!attempt) return;

  if (job.status === "succeeded") {
    queueVerificationJob(state, incident, job.beeId, now);
  } else {
    markUnresolved(incident, now, `${job.type} failed before recovery could be verified.`);
  }
}

function updateIncidentFromAiDiagnosis(incident: IncidentRecord, job: JobRecord, now: Date): void {
  const summary =
    typeof job.output?.summary === "string"
      ? job.output.summary
      : typeof job.output?.recommendation === "string"
        ? job.output.recommendation
        : undefined;
  const nextAction =
    typeof job.output?.recommendedAction === "string" &&
    AUTO_APPROVED_JOB_TYPES.has(job.output.recommendedAction as JobType)
      ? (job.output.recommendedAction as JobType)
      : undefined;

  if (summary) incident.lastDiagnosis = summary;
  if (nextAction) incident.nextAction = nextAction;
  incident.updatedAt = now.toISOString();
}

function queueVerificationJob(
  state: HiveServerState,
  incident: IncidentRecord,
  beeId: string,
  now: Date,
): void {
  if (incident.verification && incident.verification.status !== "failed") {
    incident.status = "recovering";
    incident.updatedAt = now.toISOString();
    incident.nextAction = "run_healthcheck";
    return;
  }
  if (hasActiveJob(state, beeId, "run_healthcheck")) {
    incident.status = "recovering";
    incident.updatedAt = now.toISOString();
    incident.nextAction = "run_healthcheck";
    return;
  }
  const job = createJob(
    state.jobsState,
    beeId,
    { type: "run_healthcheck", payload: { incidentId: incident.id } },
    now,
  );
  incident.verification = {
    jobId: job.id,
    queuedAt: now.toISOString(),
  };
  incident.status = "recovering";
  incident.updatedAt = now.toISOString();
  incident.nextAction = "run_healthcheck";
}

function incidentHasSuccessfulVerification(incident: IncidentRecord): boolean {
  if (incident.attempts.length === 0) return true;
  return incident.verification?.status === "succeeded";
}

function queueIncidentNotification(
  incident: IncidentRecord,
  status: Extract<IncidentStatus, "needs_approval" | "unresolved">,
  now: Date,
): void {
  if (incident.notifications.some((notification) => notification.status === status)) return;
  incident.notifications.push({
    id: `${incident.id}:${status}`,
    status,
    queuedAt: now.toISOString(),
    message: `${incident.summary} (${status.replace("_", " ")})`,
    deliveryStatus: "queued",
    deliveryAttempts: 0,
  });
}

async function deliverIncidentNotifications(
  state: HiveServerState,
  notifier: IncidentNotifier,
  now: Date,
  options: { force?: boolean } = {},
): Promise<void> {
  for (const incident of state.incidents.values()) {
    for (const notification of incident.notifications) {
      if (!shouldAttemptNotificationDelivery(notification, now, options.force ?? false)) continue;
      notification.deliveryStatus = "delivering";
      notification.deliveryChannel = notifier.channel;
      notification.deliveryAttempts += 1;
      notification.lastAttemptAt = now.toISOString();
      delete notification.lastError;

      try {
        const bee = state.bees.get(incident.beeId);
        await notifier.deliver({
          incident,
          notification,
          ...(bee ? { bee } : {}),
        });
        notification.deliveryStatus = "sent";
        notification.deliveredAt = now.toISOString();
      } catch (error) {
        notification.deliveryStatus = "failed";
        notification.lastError = error instanceof Error ? error.message : String(error);
      } finally {
        incident.updatedAt = now.toISOString();
      }
    }
  }
}

function shouldAttemptNotificationDelivery(
  notification: IncidentNotification,
  now: Date,
  force: boolean,
): boolean {
  if (notification.deliveryStatus === "sent" || notification.deliveryStatus === "delivering") {
    return false;
  }
  if (force) return true;
  if (notification.deliveryStatus === "queued") return true;
  if (notification.deliveryAttempts >= INCIDENT_NOTIFICATION_MAX_ATTEMPTS) return false;
  const lastAttemptMs = notification.lastAttemptAt
    ? new Date(notification.lastAttemptAt).getTime()
    : 0;
  return (
    !Number.isFinite(lastAttemptMs) ||
    now.getTime() - lastAttemptMs >= INCIDENT_NOTIFICATION_RETRY_COOLDOWN_MS
  );
}

export function createIncidentNotifierFromEnv(): IncidentNotifier | null {
  const command = process.env.HIVEPLANE_INCIDENT_NOTIFY_COMMAND;
  if (command) {
    return createCommandIncidentNotifier(
      command,
      parseJsonStringArrayEnv("HIVEPLANE_INCIDENT_NOTIFY_ARGS"),
    );
  }

  const webhookUrl = process.env.HIVEPLANE_INCIDENT_WEBHOOK_URL;
  if (webhookUrl) return createWebhookIncidentNotifier(webhookUrl);
  return null;
}

export function createWebhookIncidentNotifier(webhookUrl: string): IncidentNotifier {
  return {
    channel: "webhook",
    deliver: async (payload) => {
      const timeoutMs = parsePositiveInt(process.env.HIVEPLANE_INCIDENT_NOTIFY_TIMEOUT_MS) ?? 5000;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetch(webhookUrl, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "user-agent": "HivePlane/0.0.7 incident-notifier",
          },
          body: JSON.stringify(payload),
          signal: controller.signal,
        });
        if (!response.ok) {
          const body = await response.text().catch(() => "");
          throw new Error(
            `webhook returned ${response.status}${body ? `: ${body.slice(0, 200)}` : ""}`,
          );
        }
      } finally {
        clearTimeout(timeout);
      }
    },
  };
}

export function createCommandIncidentNotifier(
  command: string,
  args: string[] = [],
): IncidentNotifier {
  return {
    channel: "command",
    deliver: (payload) =>
      new Promise<void>((resolve, reject) => {
        const child = spawn(command, args, { stdio: ["pipe", "ignore", "pipe"] });
        let stderr = "";
        child.stderr?.on("data", (chunk) => {
          stderr = `${stderr}${String(chunk)}`.slice(-2000);
        });
        child.on("error", reject);
        child.on("close", (code) => {
          if (code === 0) resolve();
          else
            reject(new Error(`notify command exited ${code}${stderr ? `: ${stderr.trim()}` : ""}`));
        });
        child.stdin.end(`${JSON.stringify(payload)}\n`);
      }),
  };
}

function parseJsonStringArrayEnv(name: string): string[] {
  const value = process.env[name];
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    if (Array.isArray(parsed) && parsed.every((item) => typeof item === "string")) return parsed;
  } catch {
    // Fall through to a single argument; useful for simple shell-free commands.
  }
  return [value];
}

function queueAiDiagnosis(
  state: HiveServerState,
  incident: IncidentRecord,
  bee: HiveBeeRecord,
  now: Date,
): void {
  if (incident.attempts.length > 0) return;
  if (hasActiveJob(state, bee.beeId, "diagnose_incident")) return;
  createJob(
    state.jobsState,
    bee.beeId,
    {
      type: "diagnose_incident",
      payload: {
        incidentId: incident.id,
        kind: incident.kind,
        severity: incident.severity,
        summary: incident.summary,
        detectedAt: incident.detectedAt,
        healthChecks: bee.healthChecks,
        profile: bee.profile,
        lastSeenAt: bee.lastSeenAt,
        status: bee.status,
        queuedAt: now.toISOString(),
      },
    },
    now,
  );
}

function hasActiveJob(state: HiveServerState, beeId: string, action: JobType): boolean {
  const activeStatuses = new Set<JobStatus>([
    "created",
    "queued",
    "assigned",
    "accepted_by_bee",
    "running",
    "waiting_for_approval",
  ]);
  return [...state.jobsState.jobs.values()].some(
    (job) => job.beeId === beeId && job.type === action && activeStatuses.has(job.status),
  );
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
