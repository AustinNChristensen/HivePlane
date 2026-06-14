import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { createServer as createHttpsServer } from "node:https";
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
  type WorkContext,
  type JsonValue,
  type JobType,
  type JobStatus,
  type RescueHeartbeat,
} from "@hiveplane/protocol";
import {
  extractBearer,
  formatPairingKeyForDisplay,
  generateBootstrapToken,
  generateOperatorSessionToken,
  generateOperatorToken,
  generatePairingKey,
  generateSessionToken,
  getRequiredAdminToken,
  isAuthRequired,
  looksLikeBootstrapToken,
  looksLikeOperatorSessionToken,
  looksLikeOperatorToken,
  looksLikePairingKey,
  looksLikeSessionToken,
  PAIRING_KEY_DEFAULT_TTL_MS,
  safeEquals,
  sha256Hex,
  verifyBeeSignature,
  type BootstrapTokenRecord,
  type OperatorSessionRecord,
  type PairingKeyRecord,
  type SessionRecord,
} from "./auth.js";
import { getHiveInfo } from "./hive-info.js";
import {
  appendEvents,
  appendSystemJobEvent,
  approveJob,
  cancelJob,
  claimPendingJobCancellations,
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
export const PERMISSION_PROFILE_IDS = [
  "read_only_observer",
  "finance_safe",
  "personal_assistant",
  "browser_worker",
  "server_worker",
  "dev_box",
] as const;
export type PermissionProfileId = (typeof PERMISSION_PROFILE_IDS)[number];
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
  permissionProfile: PermissionProfileId;
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
  artifactIds?: string[];
};

export type IncidentVerification = {
  jobId: string;
  queuedAt: string;
  completedAt?: string;
  status?: JobStatus;
  artifactIds?: string[];
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
  /** Scheduled and signal-triggered background automations. */
  automations: Map<string, HiveAutomationRecord>;
  /** Operator/security audit entries keyed by audit id. */
  auditLog: Map<string, AuditLogEntry>;
  /** Human/operator identities keyed by user id. */
  operators: Map<string, HiveOperatorRecord>;
  /** Browser/API operator sessions keyed by token hash. */
  operatorSessions: Map<string, OperatorSessionRecord>;
  /** Organization/team boundaries keyed by organization id. */
  organizations: Map<string, HiveOrganizationRecord>;
  /** System authorization domains keyed by system id. */
  systems: Map<string, HiveSystemRecord>;
  /** User grants keyed by `${userId}:${systemId}:${permission}`. */
  userSystemPermissions: Map<string, UserSystemPermissionRecord>;
  /** Bee access keyed by `${beeId}:${systemId}`. */
  beeSystemAccess: Map<string, BeeSystemAccessRecord>;
  /** Desired sub-agent definitions keyed by sub-agent id. */
  subAgentDefinitions: Map<string, HiveSubAgentDefinitionRecord>;
};

export type HiveOrgRole = "owner" | "admin" | "developer" | "operator" | "viewer";
export type HiveSystemRisk = "low" | "medium" | "high" | "critical";
export type HiveSystemPermission = "view" | "run" | "approve" | "admin" | "audit";
export type BeeSystemAccessMode = "none" | "limited" | "universal";

export type HiveOrganizationRecord = {
  id: string;
  slug: string;
  name: string;
  createdAt: string;
};

export type HiveOperatorRecord = {
  userId: string;
  organizationId: string;
  email: string;
  name?: string;
  role: HiveOrgRole;
  tokenHash: string;
  createdAt: string;
  revokedAt?: string;
};

export type HiveSystemRecord = {
  id: string;
  organizationId: string;
  slug: string;
  name: string;
  risk: HiveSystemRisk;
  description?: string;
  archivedAt?: string;
  createdAt: string;
};

export type UserSystemPermissionRecord = {
  userId: string;
  systemId: string;
  permission: HiveSystemPermission;
  grantedByUserId?: string;
  createdAt: string;
};

export type BeeSystemAccessRecord = {
  beeId: string;
  systemId: string;
  access: BeeSystemAccessMode;
  grantedByUserId?: string;
  createdAt: string;
};

export type HiveSubAgentDefinitionRecord = {
  id: string;
  name: string;
  runtime: string;
  systemId: string;
  modelProvider?: string;
  model?: string;
  tools: string[];
  skills: string[];
  workingDirectories: string[];
  targetBeeIds: string[];
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
};

export type AuditLogEntry = {
  id: string;
  actorType: "user" | "bee" | "hive" | "system";
  actorId?: string;
  action: string;
  resourceType?: string;
  resourceId?: string;
  data: Record<string, JsonValue>;
  createdAt: string;
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
  modelBackends: string[];
  models: string[];
  connectors: string[];
};

export type HiveTaskRecord = {
  id: string;
  title: string;
  instructions: string;
  targetSystemId: string;
  requestedBy?: string;
  preferredBeeId?: string;
  requestedSubAgentId?: string;
  requirements: HiveTaskRequirements;
  context?: WorkContext;
  status: HiveTaskStatus;
  assignedBeeId?: string;
  jobId?: string;
  createdAt: string;
  updatedAt: string;
  lastError?: string;
};

export type HiveAutomationStatus = "enabled" | "paused" | "failed";

export type HiveAutomationRecord = {
  id: string;
  title: string;
  instructions: string;
  targetSystemId: string;
  requestedBy?: string;
  preferredBeeId?: string;
  requirements: HiveTaskRequirements;
  context?: WorkContext;
  trigger: "interval" | "signal";
  everySeconds?: number;
  enabled: boolean;
  status: HiveAutomationStatus;
  createdAt: string;
  updatedAt: string;
  nextRunAt?: string;
  lastRunAt?: string;
  lastTaskId?: string;
  lastJobId?: string;
  failureCount: number;
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
  /** Optional native TLS material. When set, the Hive listens with HTTPS. */
  tls?: {
    cert: string | Buffer;
    key: string | Buffer;
  };
  /** Optional sink for unresolved / approval-needed incident alerts. */
  incidentNotifier?: IncidentNotifier | null;
};

export function createHiveServerState(): HiveServerState {
  const state: HiveServerState = {
    bees: new Map(),
    bootstrapTokens: new Map(),
    sessions: new Map(),
    retiredPairingKeys: [],
    pairingAttempts: new Map(),
    jobsState: createJobsState(),
    incidents: new Map(),
    tasks: new Map(),
    automations: new Map(),
    auditLog: new Map(),
    operators: new Map(),
    operatorSessions: new Map(),
    organizations: new Map(),
    systems: new Map(),
    userSystemPermissions: new Map(),
    beeSystemAccess: new Map(),
    subAgentDefinitions: new Map(),
  };
  seedDefaultOrganization(state, new Date("2026-01-01T00:00:00.000Z"));
  seedDefaultSystems(state, new Date("2026-01-01T00:00:00.000Z"));
  return state;
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

const DEFAULT_ORGANIZATION_ID = "org_default";
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
    modelBackends: z.array(z.string().min(1)).default([]),
    models: z.array(z.string().min(1)).default([]),
    connectors: z.array(z.string().min(1)).default([]),
  })
  .default({});
const CreateHiveTaskRequestSchema = z.object({
  title: z.string().min(1).max(120),
  instructions: z.string().min(1).max(8000),
  targetSystemId: z.string().min(1).default("public"),
  requestedBy: z.string().min(1).max(120).optional(),
  preferredBeeId: z.string().min(1).optional(),
  requestedSubAgentId: z.string().min(1).optional(),
  requirements: TaskRequirementsSchema,
  context: z
    .object({
      sessionId: z.string().min(1).optional(),
      runtime: z.string().min(1).optional(),
      workingDirectory: z.string().min(1).optional(),
      files: z.array(z.string().min(1)).default([]),
      artifacts: z.array(z.string().min(1)).default([]),
      metadata: z.record(z.unknown()).default({}),
    })
    .default({}),
});

const CreateSubAgentDefinitionRequestSchema = z.object({
  name: z.string().min(1).max(120),
  runtime: z.string().min(1).default("openclaw"),
  systemId: z.string().min(1).default("public"),
  modelProvider: z.string().min(1).max(120).optional(),
  model: z.string().min(1).max(200).optional(),
  tools: z.array(z.string().min(1)).default([]),
  skills: z.array(z.string().min(1)).default([]),
  workingDirectories: z.array(z.string().min(1)).default([]),
  targetBeeIds: z.array(z.string().min(1)).default([]),
  enabled: z.boolean().default(true),
});

const CreateHiveAutomationRequestSchema = CreateHiveTaskRequestSchema.extend({
  trigger: z.enum(["interval", "signal"]).default("interval"),
  everySeconds: z
    .number()
    .int()
    .min(60)
    .max(60 * 60 * 24 * 30)
    .optional(),
  enabled: z.boolean().default(true),
});

const CreateOperatorRequestSchema = z.object({
  email: z.string().email(),
  organizationId: z.string().min(1).default(DEFAULT_ORGANIZATION_ID),
  name: z.string().min(1).max(120).optional(),
  role: z.enum(["owner", "admin", "developer", "operator", "viewer"]).default("operator"),
});

const LoginRequestSchema = z.object({
  token: z.string().min(1),
});

const GrantSystemPermissionRequestSchema = z.object({
  userId: z.string().min(1),
  systemId: z.string().min(1).default("public"),
  permissions: z.array(z.enum(["view", "run", "approve", "admin", "audit"])).min(1),
});

const GrantBeeSystemAccessRequestSchema = z.object({
  beeId: z.string().min(1),
  systemId: z.string().min(1).default("public"),
  access: z.enum(["none", "limited", "universal"]).default("limited"),
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
  "openclaw_subagents_list",
  "openclaw_subagent_smoke_test",
  "ollama_status",
  "ollama_list_models",
  "ollama_smoke_test",
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

  const handler = async (request: IncomingMessage, response: ServerResponse) => {
    try {
      const url = new URL(request.url ?? "/", "http://localhost");

      // Public landing page: GET / serves the website front door, while the
      // operator dashboard stays available at /dashboard and /index.html.
      if (request.method === "GET" && url.pathname === "/") {
        const landingPath = join(publicDir, "landing.html");
        try {
          const html = readFileSync(landingPath, "utf8");
          response.writeHead(200, {
            "content-type": "text/html; charset=utf-8",
            "cache-control": "no-store",
          });
          response.end(html);
          return;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            return sendJson(response, 404, {
              error: "landing_not_built",
              message: `landing page not found at ${landingPath}. The Hive process may be running an older revision than the source on disk — restart it.`,
            });
          }
          throw error;
        }
      }

      // Dashboard: GET /dashboard, /dashboard/, and /index.html serve the static index.html.
      if (
        request.method === "GET" &&
        (url.pathname === "/dashboard" ||
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

      if (request.method === "GET" && url.pathname === "/api/auth/me") {
        const actor = requireOperatorOrSend(request, response, state, adminToken);
        if (!actor) return;
        return sendJson(response, 200, {
          actor,
          permissions: serializeActorPermissions(state, actor),
        });
      }

      if (request.method === "POST" && url.pathname === "/api/auth/login") {
        const { body } = await readJson(request);
        const parsed = LoginRequestSchema.safeParse(body);
        if (!parsed.success) {
          return sendJson(response, 400, {
            error: "bad_request",
            message: parsed.error.message,
          });
        }
        const authRequest = {
          ...request,
          headers: { ...request.headers, authorization: `Bearer ${parsed.data.token}` },
        } as IncomingMessage;
        const auth = requireOperator(authRequest, state, adminToken);
        if (!auth.ok) return sendJson(response, auth.status, auth.body);
        const current = now();
        const created = createOperatorSession(state, auth.actor, current);
        const auditRequest = {
          ...request,
          headers: { ...request.headers, "x-hiveplane-actor": auth.actor.userId },
        } as unknown as IncomingMessage;
        recordAudit(state, auditRequest, current, {
          action: "operator.session.create",
          resourceType: "operator_session",
          resourceId: created.session.sessionId,
          data: {
            userId: auth.actor.userId,
            role: auth.actor.role,
            expiresAt: created.session.expiresAt.toISOString(),
          },
        });
        markDirty();
        return sendJson(response, 200, {
          token: created.token,
          session: {
            sessionId: created.session.sessionId,
            userId: created.session.userId,
            createdAt: created.session.createdAt.toISOString(),
            expiresAt: created.session.expiresAt.toISOString(),
          },
          actor: auth.actor,
          permissions: serializeActorPermissions(state, auth.actor),
        });
      }

      if (request.method === "DELETE" && url.pathname === "/api/auth/session") {
        const actor = requireOperatorOrSend(request, response, state, adminToken);
        if (!actor) return;
        const bearer = extractBearer(request);
        if ("error" in bearer || !looksLikeOperatorSessionToken(bearer.token)) {
          return sendJson(response, 400, {
            error: "bad_request",
            reason: "current credential is not an operator session",
          });
        }
        const tokenHash = sha256Hex(bearer.token);
        const session = state.operatorSessions.get(tokenHash);
        if (session) {
          session.revokedAt = now();
          state.operatorSessions.delete(tokenHash);
        }
        const current = now();
        recordAudit(state, request, current, {
          action: "operator.session.revoke",
          resourceType: "operator_session",
          resourceId: actor.sessionId ?? "unknown",
          data: { userId: actor.userId },
        });
        markDirty();
        return sendJson(response, 200, { revoked: true });
      }

      if (request.method === "GET" && url.pathname === "/api/systems") {
        const actor = requireOperatorOrSend(request, response, state, adminToken);
        if (!actor) return;
        return sendJson(response, 200, {
          systems: serializeSystemsForActor(state, actor),
        });
      }

      if (request.method === "GET" && url.pathname === "/api/organizations") {
        const actor = requireOperatorOrSend(request, response, state, adminToken);
        if (!actor) return;
        return sendJson(response, 200, {
          organizations: serializeOrganizationsForActor(state, actor),
        });
      }

      if (request.method === "POST" && url.pathname === "/api/operators") {
        const actor = requireOperatorOrSend(request, response, state, adminToken, {
          minRole: "admin",
        });
        if (!actor) return;
        const { body } = await readJson(request);
        const parsed = CreateOperatorRequestSchema.safeParse(body);
        if (!parsed.success) {
          return sendJson(response, 400, {
            error: "bad_request",
            message: parsed.error.message,
          });
        }
        if (!state.organizations.has(parsed.data.organizationId)) {
          return sendJson(response, 404, {
            error: "not_found",
            reason: "organization not found",
          });
        }
        if (!actorCanManageOrganization(actor, parsed.data.organizationId)) {
          return sendJson(response, 403, {
            error: "forbidden",
            reason: "operator cannot create users in another organization",
          });
        }
        const current = now();
        const created = createOperator(state, parsed.data, current);
        recordAudit(state, request, current, {
          action: "operator.create",
          resourceType: "operator",
          resourceId: created.operator.userId,
          data: {
            email: created.operator.email,
            role: created.operator.role,
            organizationId: created.operator.organizationId,
          },
        });
        markDirty();
        return sendJson(response, 200, {
          operator: redactOperator(created.operator),
          token: created.token,
          tokenId: created.tokenId,
        });
      }

      if (request.method === "GET" && url.pathname === "/api/operators") {
        const actor = requireOperatorOrSend(request, response, state, adminToken, {
          minRole: "admin",
        });
        if (!actor) return;
        return sendJson(response, 200, {
          operators: [...state.operators.values()]
            .filter(
              (operator) =>
                actor.adminToken ||
                actor.role === "owner" ||
                operator.organizationId === actor.organizationId,
            )
            .map(redactOperator),
        });
      }

      if (request.method === "GET" && url.pathname === "/api/system-permissions") {
        const actor = requireOperatorOrSend(request, response, state, adminToken, {
          minRole: "admin",
        });
        if (!actor) return;
        return sendJson(response, 200, {
          grants: [...state.userSystemPermissions.values()].filter((grant) =>
            actorCanSeeSystem(state, actor, grant.systemId),
          ),
        });
      }

      if (request.method === "POST" && url.pathname === "/api/system-permissions") {
        const actor = requireOperatorOrSend(request, response, state, adminToken, {
          minRole: "admin",
        });
        if (!actor) return;
        const { body } = await readJson(request);
        const parsed = GrantSystemPermissionRequestSchema.safeParse(body);
        if (!parsed.success) {
          return sendJson(response, 400, {
            error: "bad_request",
            message: parsed.error.message,
          });
        }
        const grantee = state.operators.get(parsed.data.userId);
        if (!grantee) {
          return sendJson(response, 404, { error: "not_found", reason: "operator not found" });
        }
        const system = state.systems.get(parsed.data.systemId);
        if (!system) {
          return sendJson(response, 404, { error: "not_found", reason: "system not found" });
        }
        if (
          grantee.organizationId !== system.organizationId ||
          !actorCanManageOrganization(actor, system.organizationId)
        ) {
          return sendJson(response, 403, {
            error: "forbidden",
            reason: "operator cannot grant permissions across organization boundaries",
          });
        }
        const current = now();
        const grants = grantSystemPermissions(state, parsed.data, actor, current);
        recordAudit(state, request, current, {
          action: "system_permission.grant",
          resourceType: "system",
          resourceId: parsed.data.systemId,
          data: { userId: parsed.data.userId, permissions: parsed.data.permissions },
        });
        markDirty();
        return sendJson(response, 200, { grants });
      }

      if (request.method === "GET" && url.pathname === "/api/bee-system-access") {
        const actor = requireOperatorOrSend(request, response, state, adminToken, {
          minRole: "admin",
        });
        if (!actor) return;
        return sendJson(response, 200, {
          grants: [...state.beeSystemAccess.values()].filter((grant) =>
            actorCanSeeSystem(state, actor, grant.systemId),
          ),
        });
      }

      if (request.method === "POST" && url.pathname === "/api/bee-system-access") {
        const actor = requireOperatorOrSend(request, response, state, adminToken, {
          minRole: "admin",
        });
        if (!actor) return;
        const { body } = await readJson(request);
        const parsed = GrantBeeSystemAccessRequestSchema.safeParse(body);
        if (!parsed.success) {
          return sendJson(response, 400, {
            error: "bad_request",
            message: parsed.error.message,
          });
        }
        if (!state.bees.has(parsed.data.beeId)) {
          return sendJson(response, 404, { error: "not_found", reason: "bee not registered" });
        }
        const system = state.systems.get(parsed.data.systemId);
        if (!system) {
          return sendJson(response, 404, { error: "not_found", reason: "system not found" });
        }
        if (!actorCanManageOrganization(actor, system.organizationId)) {
          return sendJson(response, 403, {
            error: "forbidden",
            reason: "operator cannot grant Bee access across organization boundaries",
          });
        }
        const current = now();
        const grant = grantBeeSystemAccess(state, parsed.data, actor, current);
        recordAudit(state, request, current, {
          action: "bee_system_access.grant",
          resourceType: "bee",
          resourceId: parsed.data.beeId,
          data: { systemId: parsed.data.systemId, access: parsed.data.access },
        });
        markDirty();
        return sendJson(response, 200, { grant });
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
        recordAudit(state, request, now(), {
          action: "bee.delete",
          resourceType: "bee",
          resourceId: beeId,
          data: {},
        });
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
        recordAudit(state, request, now(), {
          action: "bee.profile.update",
          resourceType: "bee",
          resourceId: beeId,
          data: {
            availabilityClass: parsed.profile.availabilityClass,
            permissionProfile: parsed.profile.permissionProfile,
            offlineGraceSeconds: parsed.profile.offlineGraceSeconds,
            activeJobPolicy: parsed.profile.activeJobPolicy,
            autoRepairWhenOnline: parsed.profile.autoRepairWhenOnline,
            warnings: parsed.warnings,
          },
        });
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
        recordAudit(state, request, now(), {
          action: "bootstrap_token.create",
          resourceType: "bootstrap_token",
          resourceId: created.tokenId,
          data: {
            beeName: parsed.data.beeName ?? null,
            expiresAt: created.expiresAt,
          },
        });
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
        recordAudit(state, request, now(), {
          action: "pairing_key.rotate",
          resourceType: "pairing_key",
          resourceId: record.code,
          data: { expiresAt: record.expiresAt.toISOString() },
        });
        markDirty();
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
        const cancellations = claimPendingJobCancellations(
          state.jobsState,
          heartbeat.beeId,
          current,
        );
        const jobs = claimPendingJobs(state.jobsState, heartbeat.beeId, current, {
          excludeTypes: RESCUE_JOB_TYPES,
        });
        markDirty();
        return sendJson(response, 200, { accepted: true, bee, jobs, cancellations });
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
        recordAudit(state, request, now(), {
          action: "job.create",
          resourceType: "job",
          resourceId: job.id,
          data: { beeId, type: job.type, status: job.status },
        });
        markDirty();
        return sendJson(response, 200, { job: serializeJob(job) });
      }

      const approveJobMatch = /^\/api\/jobs\/([^/]+)\/approve$/.exec(url.pathname);
      if (request.method === "POST" && approveJobMatch) {
        const actor = requireOperatorOrSend(request, response, state, adminToken);
        if (!actor) return;
        const jobId = decodeURIComponent(approveJobMatch[1] ?? "");
        const existing = findJob(state.jobsState, jobId);
        if (!existing) return sendJson(response, 404, { error: "not_found" });
        if (
          !requireSystemPermissionOrSend(
            response,
            state,
            actor,
            jobTargetSystemId(existing),
            "approve",
          )
        ) {
          return;
        }
        const current = now();
        const job =
          approveJob(state.jobsState, jobId, {
            approvedBy: actor.userId,
            approvedAt: current.toISOString(),
          }) ?? existing;
        recordAudit(state, request, current, {
          action: "job.approve",
          resourceType: "job",
          resourceId: job.id,
          data: { beeId: job.beeId, type: job.type },
        });
        markDirty();
        return sendJson(response, 200, { job: serializeJob(job) });
      }

      const denyJobMatch = /^\/api\/jobs\/([^/]+)\/deny$/.exec(url.pathname);
      if (request.method === "POST" && denyJobMatch) {
        const actor = requireOperatorOrSend(request, response, state, adminToken);
        if (!actor) return;
        const jobId = decodeURIComponent(denyJobMatch[1] ?? "");
        const existing = findJob(state.jobsState, jobId);
        if (!existing) return sendJson(response, 404, { error: "not_found" });
        if (
          !requireSystemPermissionOrSend(
            response,
            state,
            actor,
            jobTargetSystemId(existing),
            "approve",
          )
        ) {
          return;
        }
        const job = denyJob(state.jobsState, jobId, now()) ?? existing;
        recordAudit(state, request, now(), {
          action: "job.deny",
          resourceType: "job",
          resourceId: job.id,
          data: { beeId: job.beeId, type: job.type },
        });
        markDirty();
        return sendJson(response, 200, { job: serializeJob(job) });
      }

      const cancelJobMatch = /^\/api\/jobs\/([^/]+)\/cancel$/.exec(url.pathname);
      if (request.method === "POST" && cancelJobMatch) {
        const actor = requireOperatorOrSend(request, response, state, adminToken);
        if (!actor) return;
        const jobId = decodeURIComponent(cancelJobMatch[1] ?? "");
        const existing = findJob(state.jobsState, jobId);
        if (!existing) return sendJson(response, 404, { error: "not_found" });
        if (
          !requireSystemPermissionOrSend(response, state, actor, jobTargetSystemId(existing), "run")
        ) {
          return;
        }
        if (["succeeded", "failed", "cancelled", "timed_out"].includes(existing.status)) {
          return sendJson(response, 409, {
            error: "job_not_cancellable",
            reason: `Job is already ${existing.status}.`,
          });
        }
        const current = now();
        const job = cancelJob(state.jobsState, jobId, current);
        if (job) updateHiveTaskFromJob(state, job, current);
        if (job) {
          recordAudit(state, request, current, {
            action: "job.cancel",
            resourceType: "job",
            resourceId: job.id,
            data: { beeId: job.beeId, type: job.type },
          });
        }
        markDirty();
        return sendJson(response, 200, { job: job ? serializeJob(job) : null });
      }

      const retryJobMatch = /^\/api\/jobs\/([^/]+)\/retry$/.exec(url.pathname);
      if (request.method === "POST" && retryJobMatch) {
        const actor = requireOperatorOrSend(request, response, state, adminToken);
        if (!actor) return;
        const jobId = decodeURIComponent(retryJobMatch[1] ?? "");
        const source = findJob(state.jobsState, jobId);
        if (!source) return sendJson(response, 404, { error: "not_found" });
        if (
          !requireSystemPermissionOrSend(response, state, actor, jobTargetSystemId(source), "run")
        ) {
          return;
        }
        if (!["failed", "cancelled", "timed_out"].includes(source.status)) {
          return sendJson(response, 409, {
            error: "job_not_retryable",
            reason: `Job is currently ${source.status}.`,
          });
        }
        if (typeof source.payload.taskId === "string") {
          return sendJson(response, 409, {
            error: "use_task_retry",
            reason: "This job backs a Hive task. Retry the task instead.",
          });
        }
        const current = now();
        const job = createJob(
          state.jobsState,
          source.beeId,
          {
            type: source.type,
            payload: { ...source.payload },
            ...(source.timeoutSeconds !== undefined
              ? { timeoutSeconds: source.timeoutSeconds }
              : {}),
          },
          current,
        );
        appendSystemJobEvent(source, current, "job.retry.requested", "info", {
          newJobId: job.id,
        });
        appendSystemJobEvent(job, current, "job.retry.created", "info", {
          sourceJobId: source.id,
        });
        if (jobNeedsApproval(job)) requireApproval(job);
        recordAudit(state, request, current, {
          action: "job.retry",
          resourceType: "job",
          resourceId: source.id,
          data: { beeId: source.beeId, type: source.type, newJobId: job.id },
        });
        markDirty();
        return sendJson(response, 200, {
          job: serializeJob(job),
          sourceJob: serializeJob(source),
        });
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
        const actor = requireOperatorOrSend(request, response, state, adminToken);
        if (!actor) return;
        const jobId = decodeURIComponent(getJobMatch[1] ?? "");
        const job = findJob(state.jobsState, jobId);
        if (!job) return sendJson(response, 404, { error: "not_found" });
        if (
          !requireSystemPermissionOrSend(response, state, actor, jobTargetSystemId(job), "view")
        ) {
          return;
        }
        return sendJson(response, 200, { job: serializeJob(job) });
      }

      // GET /api/jobs?beeId=… — admin list.
      if (request.method === "GET" && url.pathname === "/api/jobs") {
        const actor = requireOperatorOrSend(request, response, state, adminToken);
        if (!actor) return;
        const beeId = url.searchParams.get("beeId") ?? undefined;
        const jobs = listJobs(state.jobsState, beeId ? { beeId } : undefined)
          .filter((job) => hasSystemPermission(state, actor, jobTargetSystemId(job), "view"))
          .map(serializeJob);
        return sendJson(response, 200, { jobs });
      }

      if (request.method === "GET" && url.pathname === "/api/sub-agents") {
        const actor = requireOperatorOrSend(request, response, state, adminToken);
        if (!actor) return;
        const subAgents = serializeSubAgentDefinitions(state).filter((subAgent) =>
          hasSystemPermission(state, actor, subAgent.systemId || "public", "view"),
        );
        return sendJson(response, 200, { subAgents });
      }

      if (request.method === "POST" && url.pathname === "/api/sub-agents") {
        const actor = requireOperatorOrSend(request, response, state, adminToken);
        if (!actor) return;
        const { body } = await readJson(request);
        const parsed = CreateSubAgentDefinitionRequestSchema.safeParse(body);
        if (!parsed.success) {
          return sendJson(response, 400, {
            error: "bad_request",
            message: parsed.error.message,
          });
        }
        if (!state.systems.has(parsed.data.systemId)) {
          return sendJson(response, 400, {
            error: "unknown_system",
            reason: `System '${parsed.data.systemId}' does not exist.`,
          });
        }
        if (!requireSystemPermissionOrSend(response, state, actor, parsed.data.systemId, "admin")) {
          return;
        }
        const current = now();
        const subAgent = createSubAgentDefinition(state, parsed.data, current);
        recordAudit(state, request, current, {
          action: "sub_agent.create",
          resourceType: "sub_agent",
          resourceId: subAgent.id,
          data: {
            name: subAgent.name,
            runtime: subAgent.runtime,
            systemId: subAgent.systemId,
            targetBeeIds: subAgent.targetBeeIds,
          },
        });
        markDirty();
        return sendJson(response, 200, { subAgent: serializeSubAgentDefinition(subAgent) });
      }

      const reconcileSubAgentMatch = /^\/api\/sub-agents\/([^/]+)\/reconcile$/.exec(url.pathname);
      if (request.method === "POST" && reconcileSubAgentMatch) {
        const actor = requireOperatorOrSend(request, response, state, adminToken);
        if (!actor) return;
        const subAgentId = decodeURIComponent(reconcileSubAgentMatch[1] ?? "");
        const subAgent = state.subAgentDefinitions.get(subAgentId);
        if (!subAgent) return sendJson(response, 404, { error: "not_found" });
        if (!requireSystemPermissionOrSend(response, state, actor, subAgent.systemId, "admin")) {
          return;
        }
        const current = now();
        const targetBees = selectBeesForSubAgent(state, subAgent, current);
        const jobs = targetBees.map((bee) => {
          const job = createJob(
            state.jobsState,
            bee.beeId,
            {
              type: "openclaw_subagent_configure",
              payload: subAgentJobPayload(subAgent),
              context: {
                files: [],
                artifacts: [],
                metadata: { targetSystemId: subAgent.systemId, subAgentId: subAgent.id },
              },
            },
            current,
          );
          if (jobNeedsApproval(job)) requireApproval(job);
          return serializeJob(job);
        });
        recordAudit(state, request, current, {
          action: "sub_agent.reconcile",
          resourceType: "sub_agent",
          resourceId: subAgent.id,
          data: {
            jobIds: jobs.map((job) => String(job.id)),
            targetBeeIds: targetBees.map((bee) => bee.beeId),
          },
        });
        markDirty();
        return sendJson(response, 200, { subAgent: serializeSubAgentDefinition(subAgent), jobs });
      }

      if (request.method === "GET" && url.pathname === "/api/tasks") {
        const actor = requireOperatorOrSend(request, response, state, adminToken);
        if (!actor) return;
        return sendJson(response, 200, {
          tasks: serializeTasks(state).filter((task) =>
            hasSystemPermission(state, actor, task.targetSystemId || "public", "view"),
          ),
        });
      }

      if (request.method === "GET" && url.pathname === "/api/automations") {
        const actor = requireOperatorOrSend(request, response, state, adminToken);
        if (!actor) return;
        scheduleDueAutomations(state, now());
        markDirty();
        return sendJson(response, 200, {
          automations: serializeAutomations(state).filter((automation) =>
            hasSystemPermission(state, actor, automation.targetSystemId || "public", "view"),
          ),
        });
      }

      if (request.method === "POST" && url.pathname === "/api/automations") {
        const actor = requireOperatorOrSend(request, response, state, adminToken);
        if (!actor) return;
        const { body } = await readJson(request);
        const parsed = CreateHiveAutomationRequestSchema.safeParse(body);
        if (!parsed.success) {
          return sendJson(response, 400, {
            error: "bad_request",
            message: parsed.error.message,
          });
        }
        if (parsed.data.trigger === "interval" && !parsed.data.everySeconds) {
          return sendJson(response, 400, {
            error: "bad_request",
            reason: "interval automations require everySeconds",
          });
        }
        if (
          !requireSystemPermissionOrSend(response, state, actor, parsed.data.targetSystemId, "run")
        ) {
          return;
        }
        const current = now();
        const automation = createHiveAutomation(state, parsed.data, current);
        recordAudit(state, request, current, {
          action: "automation.create",
          resourceType: "automation",
          resourceId: automation.id,
          data: { title: automation.title, trigger: automation.trigger },
        });
        markDirty();
        return sendJson(response, 200, { automation });
      }

      const automationActionMatch =
        /^\/api\/automations\/([^/]+)\/(pause|resume|run|trigger)$/.exec(url.pathname);
      if (request.method === "POST" && automationActionMatch) {
        const actor = requireOperatorOrSend(request, response, state, adminToken);
        if (!actor) return;
        const automationId = decodeURIComponent(automationActionMatch[1] ?? "");
        const action = automationActionMatch[2] as "pause" | "resume" | "run" | "trigger";
        const automation = state.automations.get(automationId);
        if (!automation) return sendJson(response, 404, { error: "not_found" });
        const requiredPermission: HiveSystemPermission =
          action === "pause" || action === "resume" ? "admin" : "run";
        if (
          !requireSystemPermissionOrSend(
            response,
            state,
            actor,
            automation.targetSystemId || "public",
            requiredPermission,
          )
        ) {
          return;
        }
        const current = now();
        let task: HiveTaskRecord | undefined;
        if (action === "pause") {
          automation.enabled = false;
          automation.status = "paused";
          delete automation.nextRunAt;
        } else if (action === "resume") {
          automation.enabled = true;
          automation.status = "enabled";
          if (automation.trigger === "interval" && automation.everySeconds) {
            automation.nextRunAt = new Date(
              current.getTime() + automation.everySeconds * 1000,
            ).toISOString();
          }
        } else {
          task = runAutomation(
            state,
            automation,
            current,
            action === "trigger" ? "signal" : "manual",
          );
        }
        automation.updatedAt = current.toISOString();
        recordAudit(state, request, current, {
          action: `automation.${action}`,
          resourceType: "automation",
          resourceId: automation.id,
          data: { title: automation.title, ...(task ? { taskId: task.id } : {}) },
        });
        markDirty();
        return sendJson(response, 200, {
          automation,
          ...(task ? { task: serializeTask(task) } : {}),
        });
      }

      if (request.method === "GET" && url.pathname === "/api/audit-log") {
        const actor = requireOperatorOrSend(request, response, state, adminToken);
        if (!actor) return;
        if (!requireAnySystemPermissionOrSend(response, state, actor, "audit")) return;
        return sendJson(response, 200, { entries: serializeAuditLog(state) });
      }

      const getTaskMatch = /^\/api\/tasks\/([^/]+)$/.exec(url.pathname);
      if (request.method === "GET" && getTaskMatch) {
        const actor = requireOperatorOrSend(request, response, state, adminToken);
        if (!actor) return;
        const taskId = decodeURIComponent(getTaskMatch[1] ?? "");
        const task = state.tasks.get(taskId);
        if (!task) return sendJson(response, 404, { error: "not_found" });
        if (
          !requireSystemPermissionOrSend(
            response,
            state,
            actor,
            task.targetSystemId || "public",
            "view",
          )
        ) {
          return;
        }
        const job = task.jobId ? findJob(state.jobsState, task.jobId) : null;
        return sendJson(response, 200, {
          task: serializeTask(task),
          ...(job ? { job: serializeJob(job) } : {}),
        });
      }

      const retryTaskMatch = /^\/api\/tasks\/([^/]+)\/retry$/.exec(url.pathname);
      if (request.method === "POST" && retryTaskMatch) {
        const actor = requireOperatorOrSend(request, response, state, adminToken);
        if (!actor) return;
        const taskId = decodeURIComponent(retryTaskMatch[1] ?? "");
        const task = state.tasks.get(taskId);
        if (!task) return sendJson(response, 404, { error: "not_found" });
        if (
          !requireSystemPermissionOrSend(
            response,
            state,
            actor,
            task.targetSystemId || "public",
            "run",
          )
        ) {
          return;
        }
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
        recordAudit(state, request, current, {
          action: "task.retry",
          resourceType: "task",
          resourceId: task.id,
          data: { title: task.title },
        });
        markDirty();
        return sendJson(response, 200, { task: serializeTask(task) });
      }

      const cancelTaskMatch = /^\/api\/tasks\/([^/]+)\/cancel$/.exec(url.pathname);
      if (request.method === "POST" && cancelTaskMatch) {
        const actor = requireOperatorOrSend(request, response, state, adminToken);
        if (!actor) return;
        const taskId = decodeURIComponent(cancelTaskMatch[1] ?? "");
        const task = state.tasks.get(taskId);
        if (!task) return sendJson(response, 404, { error: "not_found" });
        if (
          !requireSystemPermissionOrSend(
            response,
            state,
            actor,
            task.targetSystemId || "public",
            "run",
          )
        ) {
          return;
        }
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
        recordAudit(state, request, current, {
          action: "task.cancel",
          resourceType: "task",
          resourceId: task.id,
          data: { title: task.title, jobId: task.jobId ?? null },
        });
        markDirty();
        return sendJson(response, 200, { task: serializeTask(task) });
      }

      if (request.method === "POST" && url.pathname === "/api/tasks") {
        const actor = requireOperatorOrSend(request, response, state, adminToken);
        if (!actor) return;
        const { body } = await readJson(request);
        const parsed = CreateHiveTaskRequestSchema.safeParse(body);
        if (!parsed.success) {
          return sendJson(response, 400, {
            error: "bad_request",
            message: parsed.error.message,
          });
        }
        if (
          !requireSystemPermissionOrSend(response, state, actor, parsed.data.targetSystemId, "run")
        ) {
          return;
        }
        if (parsed.data.requestedSubAgentId) {
          const subAgent = state.subAgentDefinitions.get(parsed.data.requestedSubAgentId);
          if (!subAgent) {
            return sendJson(response, 400, {
              error: "unknown_sub_agent",
              reason: `Sub-agent '${parsed.data.requestedSubAgentId}' does not exist.`,
            });
          }
          if (!subAgent.enabled) {
            return sendJson(response, 409, {
              error: "sub_agent_disabled",
              reason: `Sub-agent '${subAgent.name}' is disabled.`,
            });
          }
          if (subAgent.systemId !== parsed.data.targetSystemId) {
            return sendJson(response, 400, {
              error: "sub_agent_system_mismatch",
              reason: `Sub-agent '${subAgent.name}' belongs to System '${subAgent.systemId}', not '${parsed.data.targetSystemId}'.`,
            });
          }
        }
        const current = now();
        const task = createHiveTask(state, parsed.data, current);
        scheduleHiveTask(state, task, current);
        recordAudit(state, request, current, {
          action: "task.create",
          resourceType: "task",
          resourceId: task.id,
          data: {
            title: task.title,
            targetSystemId: task.targetSystemId,
            requestedBy: task.requestedBy ?? null,
            preferredBeeId: task.preferredBeeId ?? null,
          },
        });
        markDirty();
        return sendJson(response, 200, { task: serializeTask(task) });
      }

      if (request.method === "GET" && url.pathname === "/api/incidents") {
        const actor = requireOperatorOrSend(request, response, state, adminToken);
        if (!actor) return;
        if (!requireAnySystemPermissionOrSend(response, state, actor, "audit")) return;
        return sendJson(response, 200, { incidents: serializeIncidents(state, now()) });
      }

      if (request.method === "POST" && url.pathname === "/api/incidents/notifications/deliver") {
        const actor = requireOperatorOrSend(request, response, state, adminToken, {
          minRole: "admin",
        });
        if (!actor) return;
        if (!incidentNotifier) {
          return sendJson(response, 503, {
            error: "notification_delivery_disabled",
            reason:
              "Set HIVEPLANE_INCIDENT_WEBHOOK_URL or HIVEPLANE_INCIDENT_NOTIFY_COMMAND to enable delivery.",
          });
        }
        const current = now();
        await deliverIncidentNotifications(state, incidentNotifier, current, { force: true });
        recordAudit(state, request, current, {
          action: "incident_notifications.deliver",
          resourceType: "incident",
          data: { force: true },
        });
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
          const body = renderInstallScript(readFileSync(filePath, "utf8"));
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
  };

  return options.tls
    ? createHttpsServer({ cert: options.tls.cert, key: options.tls.key }, handler)
    : createHttpServer(handler);
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

type OperatorAuth =
  | { ok: true; actor: AuthenticatedOperator }
  | { ok: false; status: number; body: Record<string, unknown> };

type AuthenticatedOperator = {
  userId: string;
  organizationId?: string;
  role: HiveOrgRole;
  email?: string;
  adminToken: boolean;
  sessionId?: string;
};

const OPERATOR_SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 30;

function requireOperator(
  request: IncomingMessage,
  state: HiveServerState,
  adminToken: string | undefined,
  options: { minRole?: HiveOrgRole } = {},
): OperatorAuth {
  const bearer = extractBearer(request);
  if ("error" in bearer) {
    return { ok: false, status: 401, body: { error: "unauthorized", reason: bearer.error } };
  }

  if (adminToken && safeEquals(bearer.token, adminToken)) {
    return { ok: true, actor: { userId: "admin-token", role: "owner", adminToken: true } };
  }

  if (looksLikeOperatorSessionToken(bearer.token)) {
    const session = state.operatorSessions.get(sha256Hex(bearer.token));
    if (!session) {
      return {
        ok: false,
        status: 401,
        body: { error: "unauthorized", reason: "operator session not recognized" },
      };
    }
    if (session.revokedAt) {
      return {
        ok: false,
        status: 401,
        body: { error: "unauthorized", reason: "operator session revoked" },
      };
    }
    if (session.expiresAt.getTime() <= Date.now()) {
      state.operatorSessions.delete(session.tokenHash);
      return {
        ok: false,
        status: 401,
        body: { error: "unauthorized", reason: "operator session expired" },
      };
    }
    if (session.userId === "admin-token") {
      const actor: AuthenticatedOperator = {
        userId: "admin-token",
        role: "owner",
        adminToken: true,
        sessionId: session.sessionId,
      };
      if (options.minRole && !roleAtLeast(actor.role, options.minRole)) {
        return {
          ok: false,
          status: 403,
          body: { error: "forbidden", reason: `requires ${options.minRole} role or higher` },
        };
      }
      return { ok: true, actor };
    }
    const operator = state.operators.get(session.userId);
    if (!operator || operator.revokedAt) {
      return {
        ok: false,
        status: 401,
        body: { error: "unauthorized", reason: "operator for session not active" },
      };
    }
    const actor: AuthenticatedOperator = {
      userId: operator.userId,
      organizationId: operator.organizationId,
      role: operator.role,
      email: operator.email,
      adminToken: false,
      sessionId: session.sessionId,
    };
    if (options.minRole && !roleAtLeast(actor.role, options.minRole)) {
      return {
        ok: false,
        status: 403,
        body: {
          error: "forbidden",
          reason: `requires ${options.minRole} role or higher`,
        },
      };
    }
    return { ok: true, actor };
  }

  if (!looksLikeOperatorToken(bearer.token)) {
    return {
      ok: false,
      status: 401,
      body: { error: "unauthorized", reason: "operator token/session shape invalid" },
    };
  }

  const tokenHash = sha256Hex(bearer.token);
  const operator = [...state.operators.values()].find((candidate) =>
    safeEquals(candidate.tokenHash, tokenHash),
  );
  if (!operator) {
    return {
      ok: false,
      status: 401,
      body: { error: "unauthorized", reason: "operator token not recognized" },
    };
  }
  if (operator.revokedAt) {
    return {
      ok: false,
      status: 401,
      body: { error: "unauthorized", reason: "operator token revoked" },
    };
  }
  const actor: AuthenticatedOperator = {
    userId: operator.userId,
    organizationId: operator.organizationId,
    role: operator.role,
    email: operator.email,
    adminToken: false,
  };
  if (options.minRole && !roleAtLeast(actor.role, options.minRole)) {
    return {
      ok: false,
      status: 403,
      body: {
        error: "forbidden",
        reason: `requires ${options.minRole} role or higher`,
      },
    };
  }
  return { ok: true, actor };
}

function requireOperatorOrSend(
  request: IncomingMessage,
  response: ServerResponse,
  state: HiveServerState,
  adminToken: string | undefined,
  options: { minRole?: HiveOrgRole } = {},
): AuthenticatedOperator | null {
  const auth = requireOperator(request, state, adminToken, options);
  if (!auth.ok) {
    sendJson(response, auth.status, auth.body);
    return null;
  }
  return auth.actor;
}

const ROLE_RANK: Record<HiveOrgRole, number> = {
  viewer: 0,
  operator: 1,
  developer: 2,
  admin: 3,
  owner: 4,
};
const SYSTEM_PERMISSIONS: HiveSystemPermission[] = ["view", "run", "approve", "admin", "audit"];

function roleAtLeast(role: HiveOrgRole, minRole: HiveOrgRole): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[minRole];
}

function hasSystemPermission(
  state: HiveServerState,
  actor: AuthenticatedOperator,
  systemId: string,
  permission: HiveSystemPermission,
): boolean {
  if (actor.adminToken || actor.role === "owner") return true;
  const system = state.systems.get(systemId);
  if (!system) return false;
  if (!actor.organizationId || system.organizationId !== actor.organizationId) return false;
  if (actor.role === "admin") return true;
  const direct = state.userSystemPermissions.has(
    systemPermissionKey(actor.userId, systemId, permission),
  );
  if (direct) return true;
  if (permission === "view") {
    return state.userSystemPermissions.has(systemPermissionKey(actor.userId, systemId, "run"));
  }
  return false;
}

function requireSystemPermissionOrSend(
  response: ServerResponse,
  state: HiveServerState,
  actor: AuthenticatedOperator,
  systemId: string,
  permission: HiveSystemPermission,
): boolean {
  if (!state.systems.has(systemId)) {
    sendJson(response, 404, { error: "not_found", reason: `system ${systemId} not found` });
    return false;
  }
  if (!hasSystemPermission(state, actor, systemId, permission)) {
    sendJson(response, 403, {
      error: "forbidden",
      reason: `operator lacks ${permission} permission for ${systemId}`,
    });
    return false;
  }
  return true;
}

function requireAnySystemPermissionOrSend(
  response: ServerResponse,
  state: HiveServerState,
  actor: AuthenticatedOperator,
  permission: HiveSystemPermission,
): boolean {
  if (actor.adminToken || actor.role === "owner") return true;
  if (
    [...state.systems.keys()].some((systemId) =>
      hasSystemPermission(state, actor, systemId, permission),
    )
  ) {
    return true;
  }
  sendJson(response, 403, {
    error: "forbidden",
    reason: `operator lacks ${permission} permission on any System`,
  });
  return false;
}

function actorCanManageOrganization(actor: AuthenticatedOperator, organizationId: string): boolean {
  return (
    actor.adminToken ||
    actor.role === "owner" ||
    (actor.role === "admin" && actor.organizationId === organizationId)
  );
}

function actorCanSeeSystem(
  state: HiveServerState,
  actor: AuthenticatedOperator,
  systemId: string,
): boolean {
  if (actor.adminToken || actor.role === "owner") return true;
  const system = state.systems.get(systemId);
  return Boolean(system && actor.organizationId && system.organizationId === actor.organizationId);
}

function beeCanAccessSystem(state: HiveServerState, beeId: string, systemId: string): boolean {
  const direct = state.beeSystemAccess.get(beeSystemAccessKey(beeId, systemId));
  if (direct) return direct.access !== "none";
  const universal = state.beeSystemAccess.get(beeSystemAccessKey(beeId, "*"));
  if (universal) return universal.access === "universal";
  return systemId === "public";
}

function systemPermissionKey(
  userId: string,
  systemId: string,
  permission: HiveSystemPermission,
): string {
  return `${userId}:${systemId}:${permission}`;
}

function beeSystemAccessKey(beeId: string, systemId: string): string {
  return `${beeId}:${systemId}`;
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

function seedDefaultSystems(state: HiveServerState, now: Date): void {
  const defaults: Array<Omit<HiveSystemRecord, "createdAt" | "organizationId">> = [
    {
      id: "infra",
      slug: "infra",
      name: "Infrastructure",
      risk: "high",
      description: "Hive, Bee, Rescue, installers, service restarts, and fleet health.",
    },
    {
      id: "dev",
      slug: "dev",
      name: "Development",
      risk: "medium",
      description: "Repositories, coding agents, local development tools, and build/test tasks.",
    },
    {
      id: "personal",
      slug: "personal",
      name: "Personal Assistant",
      risk: "high",
      description: "Personal workflows such as Messages, Mail, Calendar, and local apps.",
    },
    {
      id: "finance",
      slug: "finance",
      name: "Finance",
      risk: "critical",
      description: "Accounting, payments, tax, and other high-risk financial workflows.",
    },
    {
      id: "public",
      slug: "public",
      name: "Public Demo",
      risk: "low",
      description: "Low-risk examples and demo work.",
    },
  ];

  for (const system of defaults) {
    if (state.systems.has(system.id)) continue;
    state.systems.set(system.id, {
      ...system,
      organizationId: DEFAULT_ORGANIZATION_ID,
      createdAt: now.toISOString(),
    });
  }
}

function seedDefaultOrganization(state: HiveServerState, now: Date): void {
  if (state.organizations.has(DEFAULT_ORGANIZATION_ID)) return;
  state.organizations.set(DEFAULT_ORGANIZATION_ID, {
    id: DEFAULT_ORGANIZATION_ID,
    slug: "default",
    name: "Default organization",
    createdAt: now.toISOString(),
  });
}

function createOperator(
  state: HiveServerState,
  request: z.infer<typeof CreateOperatorRequestSchema>,
  now: Date,
): { operator: HiveOperatorRecord; token: string; tokenId: string } {
  const token = generateOperatorToken();
  const email = request.email.trim().toLowerCase();
  const userId = `user_${sha256Hex(email).slice(0, 16)}`;
  const operator: HiveOperatorRecord = {
    userId,
    organizationId: request.organizationId,
    email,
    ...(request.name ? { name: request.name.trim() } : {}),
    role: request.role,
    tokenHash: token.tokenHash,
    createdAt: now.toISOString(),
  };
  state.operators.set(userId, operator);
  return { operator, token: token.rawToken, tokenId: token.tokenId };
}

function createOperatorSession(
  state: HiveServerState,
  actor: AuthenticatedOperator,
  now: Date,
): { session: OperatorSessionRecord; token: string } {
  const token = generateOperatorSessionToken();
  const session: OperatorSessionRecord = {
    sessionId: token.sessionId,
    userId: actor.userId,
    tokenHash: token.tokenHash,
    createdAt: now,
    expiresAt: new Date(now.getTime() + OPERATOR_SESSION_TTL_MS),
  };
  state.operatorSessions.set(session.tokenHash, session);
  return { session, token: token.rawToken };
}

function grantSystemPermissions(
  state: HiveServerState,
  request: z.infer<typeof GrantSystemPermissionRequestSchema>,
  actor: AuthenticatedOperator,
  now: Date,
): UserSystemPermissionRecord[] {
  const grants: UserSystemPermissionRecord[] = [];
  for (const permission of request.permissions) {
    const grant: UserSystemPermissionRecord = {
      userId: request.userId,
      systemId: request.systemId,
      permission,
      grantedByUserId: actor.userId,
      createdAt: now.toISOString(),
    };
    state.userSystemPermissions.set(
      systemPermissionKey(request.userId, request.systemId, permission),
      grant,
    );
    grants.push(grant);
  }
  return grants;
}

function grantBeeSystemAccess(
  state: HiveServerState,
  request: z.infer<typeof GrantBeeSystemAccessRequestSchema>,
  actor: AuthenticatedOperator,
  now: Date,
): BeeSystemAccessRecord {
  const grant: BeeSystemAccessRecord = {
    beeId: request.beeId,
    systemId: request.systemId,
    access: request.access,
    grantedByUserId: actor.userId,
    createdAt: now.toISOString(),
  };
  state.beeSystemAccess.set(beeSystemAccessKey(request.beeId, request.systemId), grant);
  return grant;
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
    ...(job.context ? { context: job.context } : {}),
    ...(job.timeoutSeconds !== undefined ? { timeoutSeconds: job.timeoutSeconds } : {}),
    createdAt: job.createdAt.toISOString(),
    ...(job.assignedAt ? { assignedAt: job.assignedAt.toISOString() } : {}),
    ...(job.completedAt ? { completedAt: job.completedAt.toISOString() } : {}),
    eventCount: job.events.length,
    events: job.events,
    artifacts: job.artifacts,
    ...(job.exitCode !== undefined ? { exitCode: job.exitCode } : {}),
    ...(job.output ? { output: job.output } : {}),
    ...(job.error ? { error: job.error } : {}),
  };
}

function jobTargetSystemId(job: JobRecord): string {
  if (typeof job.payload.targetSystemId === "string") return job.payload.targetSystemId;
  if (job.context?.metadata && typeof job.context.metadata.targetSystemId === "string") {
    return job.context.metadata.targetSystemId;
  }
  return "public";
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

function serializeSubAgentDefinitions(state: HiveServerState): HiveSubAgentDefinitionRecord[] {
  return [...state.subAgentDefinitions.values()]
    .map(serializeSubAgentDefinition)
    .sort((a, b) => a.name.localeCompare(b.name));
}

function serializeSubAgentDefinition(
  subAgent: HiveSubAgentDefinitionRecord,
): HiveSubAgentDefinitionRecord {
  return {
    ...subAgent,
    tools: [...subAgent.tools],
    skills: [...subAgent.skills],
    workingDirectories: [...subAgent.workingDirectories],
    targetBeeIds: [...subAgent.targetBeeIds],
  };
}

function serializeAutomations(state: HiveServerState): HiveAutomationRecord[] {
  return [...state.automations.values()]
    .map((automation) => ({
      ...automation,
      requirements: { ...automation.requirements },
      ...(automation.context ? { context: { ...automation.context } } : {}),
    }))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

function serializeTask(task: HiveTaskRecord): HiveTaskRecord {
  return {
    ...task,
    requirements: { ...task.requirements },
    ...(task.context ? { context: { ...task.context } } : {}),
  };
}

function serializeAuditLog(state: HiveServerState): AuditLogEntry[] {
  return [...state.auditLog.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

function redactOperator(operator: HiveOperatorRecord): Omit<HiveOperatorRecord, "tokenHash"> {
  const { tokenHash: _tokenHash, ...safe } = operator;
  return safe;
}

function serializeActorPermissions(
  state: HiveServerState,
  actor: AuthenticatedOperator,
): Record<string, HiveSystemPermission[]> {
  const permissions: Record<string, HiveSystemPermission[]> = {};
  for (const system of state.systems.values()) {
    const allowed = SYSTEM_PERMISSIONS.filter((permission) =>
      hasSystemPermission(state, actor, system.id, permission),
    );
    if (allowed.length > 0) permissions[system.id] = allowed;
  }
  return permissions;
}

function serializeSystemsForActor(
  state: HiveServerState,
  actor: AuthenticatedOperator,
): Array<HiveSystemRecord & { permissions: HiveSystemPermission[] }> {
  return [...state.systems.values()]
    .filter((system) => !system.archivedAt)
    .map((system) => ({
      ...system,
      permissions: SYSTEM_PERMISSIONS.filter((permission) =>
        hasSystemPermission(state, actor, system.id, permission),
      ),
    }))
    .filter((system) => system.permissions.length > 0)
    .sort((a, b) => a.id.localeCompare(b.id));
}

function serializeOrganizationsForActor(
  state: HiveServerState,
  actor: AuthenticatedOperator,
): HiveOrganizationRecord[] {
  return [...state.organizations.values()]
    .filter(
      (organization) =>
        actor.adminToken || actor.role === "owner" || organization.id === actor.organizationId,
    )
    .sort((a, b) => a.id.localeCompare(b.id));
}

function recordAudit(
  state: HiveServerState,
  request: IncomingMessage,
  now: Date,
  entry: Omit<AuditLogEntry, "id" | "actorType" | "actorId" | "createdAt">,
): AuditLogEntry {
  const actorId = actorIdFromRequest(request);
  const audit: AuditLogEntry = {
    id: `audit_${randomBytes(8).toString("hex")}`,
    actorType: "user",
    ...(actorId ? { actorId } : {}),
    action: entry.action,
    ...(entry.resourceType ? { resourceType: entry.resourceType } : {}),
    ...(entry.resourceId ? { resourceId: entry.resourceId } : {}),
    data: entry.data,
    createdAt: now.toISOString(),
  };
  state.auditLog.set(audit.id, audit);
  if (state.auditLog.size > 500) {
    const oldest = [...state.auditLog.values()].sort((a, b) =>
      a.createdAt.localeCompare(b.createdAt),
    )[0];
    if (oldest) state.auditLog.delete(oldest.id);
  }
  return audit;
}

function actorIdFromRequest(request: IncomingMessage): string {
  const raw = request.headers["x-hiveplane-actor"];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value) return "admin-token";
  return value.trim().slice(0, 120) || "admin-token";
}

function generateTaskId(): string {
  return `task_${randomBytes(8).toString("hex")}`;
}

function generateAutomationId(): string {
  return `auto_${randomBytes(8).toString("hex")}`;
}

function generateSubAgentId(): string {
  return `subagent_${randomBytes(8).toString("hex")}`;
}

function normalizeTaskRequirements(requirements: HiveTaskRequirements): HiveTaskRequirements {
  return {
    runtimes: dedupeStrings(requirements.runtimes),
    tools: dedupeStrings(requirements.tools),
    modelBackends: dedupeStrings(requirements.modelBackends),
    models: dedupeStrings(requirements.models),
    connectors: dedupeStrings(requirements.connectors),
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
    targetSystemId: request.targetSystemId,
    ...(request.requestedBy ? { requestedBy: request.requestedBy.trim() } : {}),
    ...(request.preferredBeeId ? { preferredBeeId: request.preferredBeeId } : {}),
    ...(request.requestedSubAgentId ? { requestedSubAgentId: request.requestedSubAgentId } : {}),
    requirements: normalizeTaskRequirements(request.requirements),
    context: normalizeWorkContext(request.context as WorkContext),
    status: "queued",
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  };
  state.tasks.set(task.id, task);
  return task;
}

function createSubAgentDefinition(
  state: HiveServerState,
  request: z.infer<typeof CreateSubAgentDefinitionRequestSchema>,
  now: Date,
): HiveSubAgentDefinitionRecord {
  const subAgent: HiveSubAgentDefinitionRecord = {
    id: generateSubAgentId(),
    name: request.name.trim(),
    runtime: request.runtime.trim(),
    systemId: request.systemId,
    ...(request.modelProvider ? { modelProvider: request.modelProvider.trim() } : {}),
    ...(request.model ? { model: request.model.trim() } : {}),
    tools: dedupeStrings(request.tools),
    skills: dedupeStrings(request.skills),
    workingDirectories: dedupeStrings(request.workingDirectories),
    targetBeeIds: dedupeStrings(request.targetBeeIds),
    enabled: request.enabled,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  };
  state.subAgentDefinitions.set(subAgent.id, subAgent);
  return subAgent;
}

function createHiveAutomation(
  state: HiveServerState,
  request: z.infer<typeof CreateHiveAutomationRequestSchema>,
  now: Date,
): HiveAutomationRecord {
  const trigger = request.trigger;
  const everySeconds =
    trigger === "interval" ? (request.everySeconds ?? 60 * 60) : request.everySeconds;
  const automation: HiveAutomationRecord = {
    id: generateAutomationId(),
    title: request.title.trim(),
    instructions: request.instructions.trim(),
    targetSystemId: request.targetSystemId,
    ...(request.requestedBy ? { requestedBy: request.requestedBy.trim() } : {}),
    ...(request.preferredBeeId ? { preferredBeeId: request.preferredBeeId } : {}),
    requirements: normalizeTaskRequirements(request.requirements),
    context: normalizeWorkContext(request.context as WorkContext),
    trigger,
    ...(everySeconds ? { everySeconds } : {}),
    enabled: request.enabled,
    status: request.enabled ? "enabled" : "paused",
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    ...(request.enabled && trigger === "interval" && everySeconds
      ? { nextRunAt: new Date(now.getTime() + everySeconds * 1000).toISOString() }
      : {}),
    failureCount: 0,
  };
  state.automations.set(automation.id, automation);
  return automation;
}

function scheduleOpenHiveTasks(state: HiveServerState, now: Date): void {
  scheduleDueAutomations(state, now);
  for (const task of state.tasks.values()) {
    if (task.status === "queued" || task.status === "blocked") {
      scheduleHiveTask(state, task, now);
    }
  }
}

function scheduleDueAutomations(state: HiveServerState, now: Date): void {
  for (const automation of state.automations.values()) {
    if (!automation.enabled || automation.status === "paused") continue;
    if (automation.trigger !== "interval") continue;
    if (!automation.nextRunAt) continue;
    if (new Date(automation.nextRunAt).getTime() > now.getTime()) continue;
    runAutomation(state, automation, now, "schedule");
  }
}

function runAutomation(
  state: HiveServerState,
  automation: HiveAutomationRecord,
  now: Date,
  triggerSource: "schedule" | "signal" | "manual",
): HiveTaskRecord {
  const task = createHiveTask(
    state,
    {
      title: automation.title,
      instructions: automation.instructions,
      targetSystemId: automation.targetSystemId,
      requestedBy: automation.requestedBy ?? `automation:${automation.id}`,
      ...(automation.preferredBeeId ? { preferredBeeId: automation.preferredBeeId } : {}),
      requirements: automation.requirements,
      context: automation.context ?? emptyWorkContext(),
    },
    now,
  );
  scheduleHiveTask(state, task, now);
  automation.lastRunAt = now.toISOString();
  automation.lastTaskId = task.id;
  if (task.jobId) automation.lastJobId = task.jobId;
  automation.updatedAt = now.toISOString();
  if (automation.trigger === "interval" && automation.everySeconds) {
    automation.nextRunAt = new Date(now.getTime() + automation.everySeconds * 1000).toISOString();
  }
  if (task.status === "blocked") {
    automation.status = "failed";
    automation.failureCount += 1;
    automation.lastError = task.lastError ?? "Automation task could not be scheduled.";
    recordAutomationFailureIncident(state, automation, task, now, triggerSource);
  } else {
    automation.status = automation.enabled ? "enabled" : "paused";
    delete automation.lastError;
  }
  return task;
}

function recordAutomationFailureIncident(
  state: HiveServerState,
  automation: HiveAutomationRecord,
  task: HiveTaskRecord,
  now: Date,
  triggerSource: string,
): void {
  const incidentId = `hive:automation:${automation.id}`;
  const summary = `Automation '${automation.title}' failed to schedule.`;
  state.incidents.set(incidentId, {
    id: incidentId,
    beeId: task.assignedBeeId ?? automation.preferredBeeId ?? "hive",
    kind: "automation_failure",
    status: "unresolved",
    severity: "warning",
    summary,
    detectedAt: now.toISOString(),
    updatedAt: now.toISOString(),
    attempts: [],
    notifications: [
      {
        id: `${incidentId}:unresolved`,
        status: "unresolved",
        queuedAt: now.toISOString(),
        message: `${summary} ${automation.lastError ?? ""}`.trim(),
        deliveryStatus: "queued",
        deliveryAttempts: 0,
      },
    ],
    lastDiagnosis: `${automation.lastError ?? "No matching healthy Bee."} Trigger: ${triggerSource}. Task: ${task.id}.`,
  });
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
        targetSystemId: task.targetSystemId,
        ...(task.requestedSubAgentId ? { subAgentId: task.requestedSubAgentId } : {}),
        requestedBy: task.requestedBy ?? "hive",
        requirements: task.requirements,
        context: task.context ?? emptyWorkContext(),
      },
      ...(task.context ? { context: task.context } : {}),
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
      if (!beeCanAccessSystem(state, bee.beeId, task.targetSystemId)) return false;
      if (task.requestedSubAgentId && !beeHasSubAgent(bee, task.requestedSubAgentId)) return false;
      return true;
    })
    .sort((a, b) => {
      const contextDelta =
        beeContextScore(b, task.context ?? emptyWorkContext()) -
        beeContextScore(a, task.context ?? emptyWorkContext());
      if (contextDelta !== 0) return contextDelta;
      return (a.activeJobs ?? 0) - (b.activeJobs ?? 0);
    });
  return candidates[0] ?? null;
}

function beeHasSubAgent(bee: HiveBeeRecord, subAgentId: string): boolean {
  return (bee.capabilities?.subAgents ?? []).some(
    (subAgent) =>
      subAgent.id === subAgentId &&
      subAgent.runtime === "openclaw" &&
      subAgent.status !== "unavailable",
  );
}

function selectBeesForSubAgent(
  state: HiveServerState,
  subAgent: HiveSubAgentDefinitionRecord,
  now: Date,
): HiveBeeRecord[] {
  const targetIds = new Set(subAgent.targetBeeIds);
  return serializeBees(state, now).filter((bee) => {
    if (targetIds.size > 0 && !targetIds.has(bee.beeId)) return false;
    if (bee.status !== "online") return false;
    if (bee.operationalState !== "healthy") return false;
    if (!bee.capabilities?.runtimes.includes(subAgent.runtime)) return false;
    if (!beeCanAccessSystem(state, bee.beeId, subAgent.systemId)) return false;
    return true;
  });
}

function subAgentJobPayload(subAgent: HiveSubAgentDefinitionRecord): Record<string, JsonValue> {
  return {
    id: subAgent.id,
    name: subAgent.name,
    runtime: subAgent.runtime,
    systemId: subAgent.systemId,
    ...(subAgent.modelProvider ? { modelProvider: subAgent.modelProvider } : {}),
    ...(subAgent.model ? { model: subAgent.model } : {}),
    tools: subAgent.tools,
    skills: subAgent.skills,
    workingDirectories: subAgent.workingDirectories,
    metadata: {
      source: "hive",
      enabled: subAgent.enabled,
    },
  };
}

function normalizeWorkContext(context: WorkContext): WorkContext {
  return {
    ...(context.sessionId ? { sessionId: context.sessionId.trim() } : {}),
    ...(context.runtime ? { runtime: context.runtime.trim() } : {}),
    ...(context.workingDirectory ? { workingDirectory: context.workingDirectory.trim() } : {}),
    files: dedupeStrings(context.files ?? []),
    artifacts: dedupeStrings(context.artifacts ?? []),
    metadata: context.metadata ?? {},
  };
}

function emptyWorkContext(): WorkContext {
  return { files: [], artifacts: [], metadata: {} };
}

function beeContextScore(bee: HiveBeeRecord, context: WorkContext): number {
  const sessions = bee.capabilities?.agentSessions ?? [];
  let score = 0;
  if (context.sessionId && sessions.some((session) => session.id === context.sessionId)) {
    score += 100;
  }
  if (context.runtime && bee.capabilities?.runtimes.includes(context.runtime)) score += 10;
  if (
    context.workingDirectory &&
    sessions.some((session) => session.workingDirectory === context.workingDirectory)
  ) {
    score += 20;
  }
  if (
    context.files.length > 0 &&
    sessions.some(
      (session) =>
        session.workingDirectory &&
        context.files.some((file) => file.startsWith(session.workingDirectory ?? "")),
    )
  ) {
    score += 5;
  }
  return score;
}

function matchesTaskRequirements(bee: HiveBeeRecord, requirements: HiveTaskRequirements): boolean {
  if (
    requirements.runtimes.length === 0 &&
    requirements.tools.length === 0 &&
    requirements.modelBackends.length === 0 &&
    requirements.models.length === 0 &&
    requirements.connectors.length === 0
  ) {
    return true;
  }
  const capabilities = bee.capabilities;
  if (!capabilities) return false;
  return (
    requirements.runtimes.every((runtime) => capabilities.runtimes.includes(runtime)) &&
    requirements.tools.every((tool) => capabilities.tools.includes(tool)) &&
    requirements.modelBackends.every((backend) => capabilities.modelBackends.includes(backend)) &&
    requirements.connectors.every((connector) =>
      (capabilities.connectors ?? []).some(
        (candidate) => candidate.id === connector && candidate.status !== "unavailable",
      ),
    ) &&
    requirements.models.every((model) => {
      if (capabilities.models.includes(model)) return true;
      return capabilities.localModels.some((localModel) => localModel.name === model);
    })
  );
}

function updateHiveTaskFromJob(state: HiveServerState, job: JobRecord, now: Date): void {
  const taskId = typeof job.payload.taskId === "string" ? job.payload.taskId : "";
  if (!taskId) return;
  const task = state.tasks.get(taskId);
  if (!task) return;
  if (job.status === "succeeded") {
    task.status = "succeeded";
    const learnedContext = contextFromJobResult(job);
    if (learnedContext) {
      task.context = normalizeWorkContext({
        ...emptyWorkContext(),
        ...task.context,
        ...learnedContext,
      });
    }
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

function contextFromJobResult(job: JobRecord): Partial<WorkContext> | null {
  const result = job.output ?? job.error;
  if (!result) return job.context ?? null;
  const context: Partial<WorkContext> = {};
  if (typeof result.sessionId === "string") context.sessionId = result.sessionId;
  if (typeof result.sessionKey === "string") context.sessionId = result.sessionKey;
  if (typeof result.runtime === "string") context.runtime = result.runtime;
  if (typeof result.workingDirectory === "string") {
    context.workingDirectory = result.workingDirectory;
  }
  if (Array.isArray(result.files)) {
    context.files = result.files.filter((item): item is string => typeof item === "string");
  }
  if (Array.isArray(result.artifacts)) {
    context.artifacts = result.artifacts.filter((item): item is string => typeof item === "string");
  }
  if (Object.keys(context).length === 0) return job.context ?? null;
  return context;
}

function defaultDeviceProfile(labels: Record<string, string> = {}, beeName = ""): BeeDeviceProfile {
  const rawClass =
    labels.availability_class ??
    labels.availabilityClass ??
    labels.availability ??
    inferAvailabilityClass(beeName);
  const availabilityClass = parseAvailabilityClass(rawClass) ?? "always_on";
  const permissionProfile =
    parsePermissionProfile(labels.permission_profile ?? labels.permissionProfile) ??
    inferPermissionProfile(availabilityClass, beeName);
  const offlineGraceSeconds =
    parsePositiveInt(labels.offline_grace_seconds ?? labels.offlineGraceSeconds) ??
    defaultOfflineGraceSeconds(availabilityClass);
  const criticalServices = parseCsv(labels.critical_services ?? labels.criticalServices);

  return {
    availabilityClass,
    permissionProfile,
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

  let permissionProfile =
    existing.permissionProfile ?? inferPermissionProfile(availabilityClass, "");
  if (input.permissionProfile !== undefined) {
    if (typeof input.permissionProfile !== "string") {
      return { error: "bad_request", reason: "permissionProfile must be a string" };
    }
    const parsed = parsePermissionProfile(input.permissionProfile);
    if (!parsed) return { error: "bad_request", reason: "permissionProfile is invalid" };
    permissionProfile = parsed;
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
    permissionProfile,
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
  if (profile.permissionProfile === "dev_box") {
    warnings.push("Dev box can run repo tools on this machine; use only for trusted workstations.");
  }
  if (
    profile.permissionProfile === "server_worker" &&
    profile.availabilityClass !== "always_on" &&
    profile.availabilityClass !== "critical"
  ) {
    warnings.push(
      "Server worker fits always-on or critical Bees better than intermittent devices.",
    );
  }
  if (
    profile.permissionProfile === "read_only_observer" &&
    profile.activeJobPolicy === "escalate"
  ) {
    warnings.push("Read-only observers can escalate incidents but will not run repair work.");
  }
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

function parsePermissionProfile(value: string | undefined): PermissionProfileId | undefined {
  return PERMISSION_PROFILE_IDS.includes(value as PermissionProfileId)
    ? (value as PermissionProfileId)
    : undefined;
}

function inferPermissionProfile(
  availabilityClass: BeeAvailabilityClass,
  beeName: string,
): PermissionProfileId {
  const normalizedName = beeName.toLowerCase();
  if (normalizedName.includes("dev")) return "dev_box";
  if (normalizedName.includes("browser")) return "browser_worker";
  if (normalizedName.includes("finance")) return "finance_safe";
  if (availabilityClass === "critical") return "server_worker";
  return "personal_assistant";
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
    if (job.artifacts.length) attempt.artifactIds = job.artifacts.map((artifact) => artifact.id);
  }

  if (incident.verification?.jobId === job.id) {
    incident.verification.completedAt = now.toISOString();
    incident.verification.status = job.status;
    if (job.artifacts.length) {
      incident.verification.artifactIds = job.artifacts.map((artifact) => artifact.id);
    }
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

function renderInstallScript(body: string): string {
  const repoUrl =
    process.env.HIVEPLANE_REPO_URL ?? "https://github.com/AustinNChristensen/HivePlane.git";
  const repoRef = process.env.HIVEPLANE_REPO_REF ?? "main";
  return body
    .replace(
      /^REPO_URL="\$\{HIVEPLANE_REPO_URL:-[^"]+\}"$/m,
      `REPO_URL="\${HIVEPLANE_REPO_URL:-${shellDoubleQuoteDefault(repoUrl)}}"`,
    )
    .replace(
      /^REPO_REF="\$\{HIVEPLANE_REPO_REF:-[^"]+\}"$/m,
      `REPO_REF="\${HIVEPLANE_REPO_REF:-${shellDoubleQuoteDefault(repoRef)}}"`,
    );
}

function shellDoubleQuoteDefault(value: string): string {
  return value.replace(/["\\$`]/g, "\\$&");
}

function sendJson(response: ServerResponse, statusCode: number, payload: unknown): void {
  response.writeHead(statusCode, { "content-type": "application/json" });
  response.end(`${JSON.stringify(payload, null, 2)}\n`);
}
