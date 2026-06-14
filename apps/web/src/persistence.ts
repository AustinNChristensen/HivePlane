import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { JobEvent, JsonValue } from "@hiveplane/protocol";
import type { BootstrapTokenRecord, SessionRecord } from "./auth.js";
import { createJobsState, type JobRecord } from "./jobs.js";
import {
  createHiveServerState,
  type AuditLogEntry,
  type BeeSystemAccessRecord,
  type HiveBeeRecord,
  type HiveAutomationRecord,
  type HiveOperatorRecord,
  type HiveServerState,
  type HiveSystemRecord,
  type HiveTaskRecord,
  type IncidentRecord,
  type UserSystemPermissionRecord,
} from "./server.js";

/**
 * Filesystem-backed persistence for HiveServerState.
 *
 * v0.0.1 design: a single JSON snapshot at `<configDir>/hive-state.json`,
 * mode 0600 (it carries session-token hashes + bootstrap-token hashes — they're
 * already hashed, but combined with bee public keys they're enough to identify
 * paired Bees, so no reason to make this world-readable). Mutations are
 * marked-dirty by HTTP handlers in `server.ts`; a debounced background flush
 * writes the file via tmp + atomic rename.
 *
 * SQLite is the right answer for v0.1. This module exists so a v0.0.1 Hive
 * restart doesn't wipe registered Bees, sessions, or in-flight jobs.
 */

const SCHEMA_VERSION = 1;

export const HIVE_STATE_FILENAME = "hive-state.json";
export const DEFAULT_FLUSH_DEBOUNCE_MS = 200;

export type PersistAttachment = {
  /** Mark the state dirty; the next debounce window will flush. */
  markDirty: () => void;
  /** Flush any pending dirty state right now. */
  flush: () => Promise<void>;
  /** Cancel pending flushes and stop the persistor. */
  stop: () => Promise<void>;
};

export function getDefaultHiveStatePath(): string {
  const configDir = process.env.HIVEPLANE_CONFIG_DIR ?? join(homedir(), ".hiveplane");
  return join(configDir, HIVE_STATE_FILENAME);
}

/**
 * Read the snapshot from disk and rehydrate it into a `HiveServerState`. If
 * the file is missing or malformed (hand-edited, partially-written from a
 * crash, schema drift across versions) we return a fresh empty state and warn
 * — losing the snapshot is preferable to crash-looping the Hive at boot.
 */
export function loadHiveServerState(filePath: string): HiveServerState {
  if (!existsSync(filePath)) return createHiveServerState();
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch (error) {
    console.warn(
      `[hive] could not read state snapshot at ${filePath} (${error instanceof Error ? error.message : String(error)}); starting fresh.`,
    );
    return createHiveServerState();
  }
  if (!raw.trim()) return createHiveServerState();

  try {
    const parsed = JSON.parse(raw) as PersistedSnapshot;
    if (parsed.schemaVersion !== SCHEMA_VERSION) {
      console.warn(
        `[hive] state snapshot at ${filePath} has schemaVersion=${parsed.schemaVersion}, expected ${SCHEMA_VERSION}; starting fresh.`,
      );
      return createHiveServerState();
    }
    return rehydrate(parsed);
  } catch (error) {
    console.warn(
      `[hive] could not parse state snapshot at ${filePath} (${error instanceof Error ? error.message : String(error)}); starting fresh.`,
    );
    return createHiveServerState();
  }
}

/**
 * Wire a debounced flush into a state. Mutations call `markDirty()`; after
 * `debounceMs` of quiet (or on `flush()` / `stop()`), the state is written
 * atomically (tmp file → rename).
 *
 * Returns the attachment so the caller — `apps/web/src/cli.ts` — can flush on
 * SIGTERM / SIGINT.
 */
export function attachPersistence(
  state: HiveServerState,
  options: {
    filePath: string;
    debounceMs?: number;
    /** Override `Date.now` for tests so debounce timing is deterministic. */
    now?: () => number;
  },
): PersistAttachment {
  const debounceMs = options.debounceMs ?? DEFAULT_FLUSH_DEBOUNCE_MS;
  let dirty = false;
  let timer: NodeJS.Timeout | undefined;
  let inflight: Promise<void> | undefined;
  let stopped = false;

  function scheduleFlush(): void {
    if (stopped) return;
    if (timer) return;
    timer = setTimeout(() => {
      timer = undefined;
      // Fire-and-forget; flush() resolves before the next markDirty() can win
      // because we set `dirty = false` before the actual write.
      inflight = doFlush().catch((error) => {
        console.warn(
          `[hive] state snapshot write failed (${error instanceof Error ? error.message : String(error)}); will retry on next dirty.`,
        );
        // Mark dirty again so we eventually retry.
        dirty = true;
      });
    }, debounceMs);
    if (typeof timer.unref === "function") timer.unref();
  }

  async function doFlush(): Promise<void> {
    if (!dirty) return;
    dirty = false;
    const snapshot = serialize(state);
    await writeAtomic(options.filePath, snapshot);
  }

  return {
    markDirty: () => {
      dirty = true;
      scheduleFlush();
    },
    flush: async () => {
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
      // Wait for any in-flight write before flushing again, so a final
      // shutdown flush doesn't race with the debounced one.
      if (inflight) await inflight.catch(() => {});
      await doFlush();
    },
    stop: async () => {
      stopped = true;
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
      if (inflight) await inflight.catch(() => {});
      await doFlush();
    },
  };
}

// --- (de)serialization ----------------------------------------------------

type PersistedSnapshot = {
  schemaVersion: number;
  writtenAt: string;
  bees: Array<[string, HiveBeeRecord]>;
  bootstrapTokens: Array<[string, PersistedBootstrapToken]>;
  sessions: Array<[string, PersistedSession]>;
  jobs: Array<[string, PersistedJob]>;
  incidents?: Array<[string, IncidentRecord]>;
  tasks?: Array<[string, HiveTaskRecord]>;
  automations?: Array<[string, HiveAutomationRecord]>;
  auditLog?: Array<[string, AuditLogEntry]>;
  operators?: Array<[string, HiveOperatorRecord]>;
  systems?: Array<[string, HiveSystemRecord]>;
  userSystemPermissions?: Array<[string, UserSystemPermissionRecord]>;
  beeSystemAccess?: Array<[string, BeeSystemAccessRecord]>;
};

type PersistedBootstrapToken = Omit<BootstrapTokenRecord, "expiresAt" | "consumedAt"> & {
  expiresAt: string;
  consumedAt?: string;
};

type PersistedSession = Omit<SessionRecord, "expiresAt" | "createdAt"> & {
  expiresAt: string;
  createdAt: string;
};

type PersistedJob = Omit<JobRecord, "createdAt" | "assignedAt" | "completedAt"> & {
  createdAt: string;
  assignedAt?: string;
  completedAt?: string;
};

function serialize(state: HiveServerState): PersistedSnapshot {
  return {
    schemaVersion: SCHEMA_VERSION,
    writtenAt: new Date().toISOString(),
    bees: [...state.bees.entries()],
    bootstrapTokens: [...state.bootstrapTokens.entries()].map(([k, v]) => [k, serializeToken(v)]),
    sessions: [...state.sessions.entries()].map(([k, v]) => [k, serializeSession(v)]),
    jobs: [...state.jobsState.jobs.entries()].map(([k, v]) => [k, serializeJob(v)]),
    incidents: [...state.incidents.entries()],
    tasks: [...state.tasks.entries()],
    automations: [...state.automations.entries()],
    auditLog: [...state.auditLog.entries()],
    operators: [...state.operators.entries()],
    systems: [...state.systems.entries()],
    userSystemPermissions: [...state.userSystemPermissions.entries()],
    beeSystemAccess: [...state.beeSystemAccess.entries()],
  };
}

function rehydrate(snapshot: PersistedSnapshot): HiveServerState {
  const state = createHiveServerState();
  for (const [k, v] of snapshot.bees) {
    state.bees.set(k, {
      ...v,
      healthChecks: v.healthChecks ?? [],
      profile: {
        ...(v.profile ?? {}),
        availabilityClass: v.profile?.availabilityClass ?? "always_on",
        permissionProfile: v.profile?.permissionProfile ?? "personal_assistant",
        offlineGraceSeconds: v.profile?.offlineGraceSeconds ?? 120,
        expectedWindows: v.profile?.expectedWindows ?? [],
        criticalServices: v.profile?.criticalServices ?? [],
        activeJobPolicy: v.profile?.activeJobPolicy ?? "escalate",
        autoRepairWhenOnline: v.profile?.autoRepairWhenOnline ?? true,
      },
    });
  }
  for (const [k, v] of snapshot.bootstrapTokens) state.bootstrapTokens.set(k, deserializeToken(v));
  for (const [k, v] of snapshot.sessions) state.sessions.set(k, deserializeSession(v));
  state.jobsState = createJobsState();
  for (const [k, v] of snapshot.jobs) state.jobsState.jobs.set(k, deserializeJob(v));
  for (const [k, v] of snapshot.incidents ?? []) {
    state.incidents.set(k, {
      ...v,
      notifications: (v.notifications ?? []).map((notification) => ({
        ...notification,
        id: notification.id ?? `${v.id}:${notification.status}`,
        deliveryStatus: notification.deliveryStatus ?? "queued",
        deliveryAttempts: notification.deliveryAttempts ?? 0,
      })),
    });
  }
  for (const [k, v] of snapshot.tasks ?? []) {
    state.tasks.set(k, {
      ...v,
      targetSystemId: v.targetSystemId ?? "public",
      ...(v.context
        ? {
            context: {
              ...(v.context.sessionId ? { sessionId: v.context.sessionId } : {}),
              ...(v.context.runtime ? { runtime: v.context.runtime } : {}),
              ...(v.context.workingDirectory
                ? { workingDirectory: v.context.workingDirectory }
                : {}),
              files: v.context.files ?? [],
              artifacts: v.context.artifacts ?? [],
              metadata: v.context.metadata ?? {},
            },
          }
        : {}),
    });
  }
  for (const [k, v] of snapshot.automations ?? []) {
    state.automations.set(k, { ...v, targetSystemId: v.targetSystemId ?? "public" });
  }
  for (const [k, v] of snapshot.auditLog ?? []) state.auditLog.set(k, v);
  for (const [k, v] of snapshot.operators ?? []) state.operators.set(k, v);
  if (snapshot.systems) {
    state.systems.clear();
    for (const [k, v] of snapshot.systems) state.systems.set(k, v);
  }
  for (const [k, v] of snapshot.userSystemPermissions ?? []) {
    state.userSystemPermissions.set(k, v);
  }
  for (const [k, v] of snapshot.beeSystemAccess ?? []) state.beeSystemAccess.set(k, v);
  return state;
}

function serializeToken(record: BootstrapTokenRecord): PersistedBootstrapToken {
  const { expiresAt, consumedAt, ...rest } = record;
  return {
    ...rest,
    expiresAt: expiresAt.toISOString(),
    ...(consumedAt ? { consumedAt: consumedAt.toISOString() } : {}),
  };
}

function deserializeToken(record: PersistedBootstrapToken): BootstrapTokenRecord {
  const { expiresAt, consumedAt, ...rest } = record;
  return {
    ...rest,
    expiresAt: new Date(expiresAt),
    ...(consumedAt ? { consumedAt: new Date(consumedAt) } : {}),
  };
}

function serializeSession(record: SessionRecord): PersistedSession {
  return {
    ...record,
    expiresAt: record.expiresAt.toISOString(),
    createdAt: record.createdAt.toISOString(),
  };
}

function deserializeSession(record: PersistedSession): SessionRecord {
  return {
    ...record,
    expiresAt: new Date(record.expiresAt),
    createdAt: new Date(record.createdAt),
  };
}

function serializeJob(record: JobRecord): PersistedJob {
  const { createdAt, assignedAt, completedAt, ...rest } = record;
  return {
    ...rest,
    createdAt: createdAt.toISOString(),
    ...(assignedAt ? { assignedAt: assignedAt.toISOString() } : {}),
    ...(completedAt ? { completedAt: completedAt.toISOString() } : {}),
  };
}

function deserializeJob(record: PersistedJob): JobRecord {
  const { createdAt, assignedAt, completedAt, events, ...rest } = record;
  return {
    ...rest,
    createdAt: new Date(createdAt),
    ...(assignedAt ? { assignedAt: new Date(assignedAt) } : {}),
    ...(completedAt ? { completedAt: new Date(completedAt) } : {}),
    // Events are protocol-shape JsonValue blobs already — no Dates inside the
    // record itself (they're ISO strings on JobEvent.createdAt).
    events: events as JobEvent[],
    payload: rest.payload as Record<string, JsonValue>,
    artifacts: rest.artifacts ?? [],
    ...(rest.output ? { output: rest.output as Record<string, JsonValue> } : {}),
    ...(rest.error ? { error: rest.error as Record<string, JsonValue> } : {}),
  };
}

// --- atomic write ----------------------------------------------------------

/**
 * Write `<path>.tmp` first, then `rename` over the live file. POSIX `rename`
 * is atomic on the same filesystem, so a crash mid-write leaves either the
 * old snapshot or the new one — never a half-written file.
 */
async function writeAtomic(path: string, body: PersistedSnapshot): Promise<void> {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  const tmp = `${path}.tmp`;
  // The serialized form is small (KB-scale for typical fleets) so sync I/O is
  // simpler and avoids partial-write races between concurrent flushes.
  writeFileSync(tmp, `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600 });
  try {
    chmodSync(tmp, 0o600);
  } catch {
    // ignore — Windows ignores POSIX modes.
  }
  renameSync(tmp, path);
}
