import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BeeHeartbeatSchema,
  BeeRegistrationRequestSchema,
  BootstrapTokenCreateRequestSchema,
  type BeeHeartbeat,
  type BeeRegistrationRequest,
  type BootstrapTokenCreateRequest,
} from "@hiveplane/protocol";
import {
  extractBearer,
  generateBootstrapToken,
  generateSessionToken,
  getRequiredAdminToken,
  isAuthRequired,
  looksLikeBootstrapToken,
  looksLikeSessionToken,
  safeEquals,
  sha256Hex,
  verifyBeeSignature,
  type BootstrapTokenRecord,
  type SessionRecord,
} from "./auth.js";

export type HiveBeeRecord = {
  beeId: string;
  beeName?: string;
  publicKey?: string;
  daemonVersion: string;
  status: BeeHeartbeat["status"];
  activeJobs: number;
  firstSeenAt: string;
  lastSeenAt: string;
  heartbeatCount: number;
};

export type HiveServerState = {
  bees: Map<string, HiveBeeRecord>;
  /** Bootstrap tokens keyed by hash of the raw token. */
  bootstrapTokens: Map<string, BootstrapTokenRecord>;
  /** Sessions keyed by hash of the raw session token. */
  sessions: Map<string, SessionRecord>;
};

export type CreateHiveServerOptions = {
  state?: HiveServerState;
  now?: () => Date;
  /** Override directory where install scripts live. Defaults to repo `infra/install`. */
  installScriptsDir?: string;
  /** Override admin token (otherwise read from HIVEPLANE_ADMIN_TOKEN). Useful for tests. */
  adminToken?: string;
  /** Override the auth-required toggle. Useful for tests. */
  authRequired?: boolean;
};

export function createHiveServerState(): HiveServerState {
  return {
    bees: new Map(),
    bootstrapTokens: new Map(),
    sessions: new Map(),
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
    firstSeenAt: existing?.firstSeenAt ?? timestamp,
    lastSeenAt: timestamp,
    heartbeatCount: (existing?.heartbeatCount ?? 0) + 1,
  };

  state.bees.set(heartbeat.beeId, record);
  return record;
}

function defaultInstallScriptsDir(): string {
  // apps/web/src/server.ts → ../../../infra/install
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, "..", "..", "..", "infra", "install");
}

const INSTALL_SCRIPT_NAMES = new Set(["bee.sh", "hive.sh"]);

const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days

export function createHiveServer(options: CreateHiveServerOptions = {}) {
  const state = options.state ?? createHiveServerState();
  const now = options.now ?? (() => new Date());
  const installScriptsDir = options.installScriptsDir ?? defaultInstallScriptsDir();
  const adminToken = options.adminToken ?? getRequiredAdminToken();
  const authRequired = options.authRequired ?? isAuthRequired();

  return createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://localhost");

      if (request.method === "GET" && url.pathname === "/healthz") {
        return sendJson(response, 200, { ok: true, service: "hiveplane-hive" });
      }

      if (request.method === "GET" && url.pathname === "/api/bees") {
        return sendJson(response, 200, { bees: [...state.bees.values()] });
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
        return sendJson(response, 200, createBootstrapToken(state, parsed.data, now()));
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
        const result = registerBee(state, parsed.data, now());
        if ("error" in result) {
          return sendJson(response, 401, result);
        }
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
        return sendJson(response, 200, { accepted: true, bee, jobs: [] });
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

export function registerBee(
  state: HiveServerState,
  request: BeeRegistrationRequest,
  now: Date,
):
  | {
      type: "bee.registration.response";
      beeId: string;
      sessionToken: string;
      sessionExpiresAt: string;
      acceptedAt: string;
    }
  | RegisterError {
  if (!looksLikeBootstrapToken(request.bootstrapToken)) {
    return { error: "unauthorized", reason: "bootstrap token shape invalid" };
  }
  const tokenHash = sha256Hex(request.bootstrapToken);
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

  const beeId = `bee_${tokenRecord.tokenId.slice(3)}_${sha256Hex(request.publicKey).slice(0, 12)}`;
  const session = generateSessionToken();
  const sessionExpiresAt = new Date(now.getTime() + SESSION_TTL_SECONDS * 1000);

  // Mark token consumed
  tokenRecord.consumedAt = now;
  tokenRecord.consumedByBeeId = beeId;

  // Persist bee record (publicKey is the auth anchor going forward)
  const existing = state.bees.get(beeId);
  state.bees.set(beeId, {
    beeId,
    beeName: request.beeName,
    publicKey: request.publicKey,
    daemonVersion: request.daemonVersion,
    status: "offline",
    activeJobs: 0,
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
