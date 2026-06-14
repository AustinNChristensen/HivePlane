import { generateKeyPairSync } from "node:crypto";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { attachPersistence, loadHiveServerState, HIVE_STATE_FILENAME } from "./persistence.js";
import {
  createHiveServer,
  createHiveServerState,
  upsertBeeHeartbeat,
  type HiveServerState,
} from "./server.js";

let dir: string;
let statePath: string;
// `loadHiveServerState` warns on malformed snapshots. The "starts fresh on
// corrupt input" test trips that warn intentionally; silencing it here keeps
// vitest output readable.
let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hp-persist-"));
  statePath = join(dir, HIVE_STATE_FILENAME);
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  warnSpy.mockRestore();
  rmSync(dir, { recursive: true, force: true });
});

function buildPopulatedState(): HiveServerState {
  const state = createHiveServerState();

  // Bee
  upsertBeeHeartbeat(
    state,
    {
      type: "bee.heartbeat",
      beeId: "bee_persist",
      timestamp: "2026-05-09T20:00:00.000Z",
      daemonVersion: "0.0.1-test",
      status: "online",
      activeJobs: 0,
      healthChecks: [],
    },
    new Date("2026-05-09T20:00:00.000Z"),
  );

  // Bootstrap token (consumed)
  state.bootstrapTokens.set("hash-bt", {
    tokenId: "bt_aaaa",
    tokenHash: "hash-bt",
    expiresAt: new Date("2026-05-09T20:30:00.000Z"),
    consumedAt: new Date("2026-05-09T20:05:00.000Z"),
    consumedByBeeId: "bee_persist",
    labels: { role: "test" },
    beeName: "test-bee",
  });

  // Session
  state.sessions.set("hash-sess", {
    sessionId: "sess_aaaa",
    beeId: "bee_persist",
    tokenHash: "hash-sess",
    expiresAt: new Date("2026-06-09T20:00:00.000Z"),
    createdAt: new Date("2026-05-09T20:05:00.000Z"),
  });

  // Job (in-flight, with one event)
  state.jobsState.jobs.set("job_aaaa", {
    id: "job_aaaa",
    beeId: "bee_persist",
    type: "run_healthcheck",
    status: "running",
    payload: {},
    artifacts: [],
    createdAt: new Date("2026-05-09T20:10:00.000Z"),
    assignedAt: new Date("2026-05-09T20:10:01.000Z"),
    events: [
      {
        id: "evt_1",
        jobId: "job_aaaa",
        beeId: "bee_persist",
        sequence: 0,
        type: "job.started",
        level: "info",
        actor: "bee",
        data: {},
        createdAt: "2026-05-09T20:10:01.000Z",
      },
    ],
  });

  state.tasks.set("task_aaaa", {
    id: "task_aaaa",
    title: "Persist task",
    instructions: "Keep this task across restarts.",
    targetSystemId: "public",
    requirements: {
      runtimes: ["openclaw"],
      tools: ["filesystem"],
      modelBackends: [],
      models: [],
      connectors: [],
    },
    status: "assigned",
    assignedBeeId: "bee_persist",
    jobId: "job_aaaa",
    createdAt: "2026-05-09T20:09:00.000Z",
    updatedAt: "2026-05-09T20:10:00.000Z",
  });

  state.auditLog.set("audit_aaaa", {
    id: "audit_aaaa",
    actorType: "user",
    actorId: "operator@example.com",
    action: "bootstrap_token.create",
    resourceType: "bootstrap_token",
    resourceId: "bt_aaaa",
    data: { beeName: "test-bee" },
    createdAt: "2026-05-09T20:11:00.000Z",
  });

  state.subAgentDefinitions.set("subagent_aaaa", {
    id: "subagent_aaaa",
    name: "Repo reviewer",
    runtime: "openclaw",
    systemId: "public",
    modelProvider: "ollama",
    model: "gemma4:12b",
    tools: ["github", "filesystem"],
    skills: ["code-review"],
    workingDirectories: ["/Users/chris/.hiveplane/install"],
    targetBeeIds: ["bee_persist"],
    enabled: true,
    createdAt: "2026-05-09T20:12:00.000Z",
    updatedAt: "2026-05-09T20:12:00.000Z",
  });

  return state;
}

describe("loadHiveServerState", () => {
  it("returns a fresh empty state when the file does not exist", () => {
    const state = loadHiveServerState(statePath);
    expect(state.bees.size).toBe(0);
    expect(state.bootstrapTokens.size).toBe(0);
    expect(state.sessions.size).toBe(0);
    expect(state.jobsState.jobs.size).toBe(0);
  });

  it("starts fresh when the file is malformed JSON", () => {
    writeFileSync(statePath, "{not valid");
    const state = loadHiveServerState(statePath);
    expect(state.bees.size).toBe(0);
  });

  it("starts fresh when the file is from a future schema version", () => {
    writeFileSync(
      statePath,
      JSON.stringify({
        schemaVersion: 999,
        writtenAt: new Date().toISOString(),
        bees: [],
        bootstrapTokens: [],
        sessions: [],
        jobs: [],
      }),
    );
    const state = loadHiveServerState(statePath);
    expect(state.bees.size).toBe(0);
  });
});

describe("attachPersistence — round-trip", () => {
  it("flushes on demand and reloads every record verbatim (Dates included)", async () => {
    const original = buildPopulatedState();
    const persistor = attachPersistence(original, { filePath: statePath, debounceMs: 5 });
    persistor.markDirty();
    await persistor.flush();

    expect(existsSync(statePath)).toBe(true);

    const reloaded = loadHiveServerState(statePath);

    // Bee record
    expect(reloaded.bees.get("bee_persist")).toMatchObject({
      beeId: "bee_persist",
      status: "online",
      heartbeatCount: 1,
    });

    // Bootstrap token: Dates rehydrate as Date objects, not strings.
    const token = reloaded.bootstrapTokens.get("hash-bt");
    expect(token).toBeDefined();
    expect(token?.expiresAt).toBeInstanceOf(Date);
    expect(token?.expiresAt.toISOString()).toBe("2026-05-09T20:30:00.000Z");
    expect(token?.consumedAt).toBeInstanceOf(Date);
    expect(token?.consumedAt?.toISOString()).toBe("2026-05-09T20:05:00.000Z");
    expect(token?.labels).toEqual({ role: "test" });

    // Session
    const session = reloaded.sessions.get("hash-sess");
    expect(session?.expiresAt).toBeInstanceOf(Date);
    expect(session?.createdAt).toBeInstanceOf(Date);
    expect(session?.beeId).toBe("bee_persist");

    // Job + events
    const job = reloaded.jobsState.jobs.get("job_aaaa");
    expect(job?.status).toBe("running");
    expect(job?.createdAt).toBeInstanceOf(Date);
    expect(job?.assignedAt).toBeInstanceOf(Date);
    expect(job?.events).toHaveLength(1);
    expect(job?.events[0]?.type).toBe("job.started");

    // Hive task
    expect(reloaded.tasks.get("task_aaaa")).toMatchObject({
      status: "assigned",
      assignedBeeId: "bee_persist",
      jobId: "job_aaaa",
    });

    // Audit log
    expect(reloaded.auditLog.get("audit_aaaa")).toMatchObject({
      actorId: "operator@example.com",
      action: "bootstrap_token.create",
      resourceType: "bootstrap_token",
      resourceId: "bt_aaaa",
    });

    expect(reloaded.subAgentDefinitions.get("subagent_aaaa")).toMatchObject({
      name: "Repo reviewer",
      runtime: "openclaw",
      systemId: "public",
      model: "gemma4:12b",
      targetBeeIds: ["bee_persist"],
    });
  });

  it("writes the snapshot file with mode 0600", async () => {
    if (process.platform === "win32") return; // Windows ignores POSIX modes.
    const persistor = attachPersistence(buildPopulatedState(), {
      filePath: statePath,
      debounceMs: 5,
    });
    persistor.markDirty();
    await persistor.flush();
    expect(statSync(statePath).mode & 0o777).toBe(0o600);
  });

  it("debounces multiple markDirty calls into a single write", async () => {
    const persistor = attachPersistence(buildPopulatedState(), {
      filePath: statePath,
      debounceMs: 30,
    });
    persistor.markDirty();
    persistor.markDirty();
    persistor.markDirty();

    // Wait past the debounce window.
    await new Promise((resolve) => setTimeout(resolve, 80));

    expect(existsSync(statePath)).toBe(true);
    const stat1 = statSync(statePath);

    // Subsequent flush() with no further marks should not produce a newer
    // mtime — the write was already done by the debounced timer.
    await persistor.flush();
    const stat2 = statSync(statePath);
    expect(stat2.mtimeMs).toBe(stat1.mtimeMs);
  });

  it("flushes pending dirty state on stop()", async () => {
    const persistor = attachPersistence(buildPopulatedState(), {
      filePath: statePath,
      // Long debounce: would never fire in time without stop()'s flush.
      debounceMs: 60_000,
    });
    persistor.markDirty();
    await persistor.stop();
    expect(existsSync(statePath)).toBe(true);
    const reloaded = loadHiveServerState(statePath);
    expect(reloaded.bees.size).toBe(1);
  });
});

describe("end-to-end via createHiveServer + persistence", () => {
  it("a Bee paired before restart is still registered after restart", async () => {
    // Boot 1: register a Bee, stop, flush.
    const state1 = createHiveServerState();
    const persistor1 = attachPersistence(state1, { filePath: statePath, debounceMs: 5 });
    const server1 = createHiveServer({
      state: state1,
      adminToken: "secret",
      onMutation: persistor1.markDirty,
    });
    server1.listen(0, "127.0.0.1");
    await once(server1, "listening");
    const addr1 = server1.address();
    if (!addr1 || typeof addr1 !== "object") throw new Error("no addr");
    const baseUrl1 = `http://127.0.0.1:${addr1.port}`;

    const tokenRes = await fetch(`${baseUrl1}/api/bootstrap-tokens`, {
      method: "POST",
      headers: { authorization: "Bearer secret", "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    const { token } = (await tokenRes.json()) as { token: string };

    const { publicKey } = generateKeyPairSync("ed25519");
    const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();

    const regRes = await fetch(`${baseUrl1}/api/bees/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        type: "bee.registration.request",
        bootstrapToken: token,
        publicKey: publicKeyPem,
        beeName: "persist-bee",
        daemonVersion: "0.0.1-test",
        hiveUrl: baseUrl1,
        labels: {},
        capabilities: {
          runtimes: [],
          modelBackends: [],
          models: [],
          localModels: [],
          tools: [],
          networking: [],
          hardware: {
            platform: "darwin-arm64",
            hostname: "test",
            cpuCores: 1,
            memoryGb: 1,
          },
        },
        requestedAt: new Date().toISOString(),
      }),
    });
    expect(regRes.status).toBe(200);
    const { beeId } = (await regRes.json()) as { beeId: string };

    await persistor1.stop();
    server1.close();

    // Boot 2: same disk path, fresh server. The Bee + session must be there.
    const state2 = loadHiveServerState(statePath);
    expect(state2.bees.get(beeId)).toBeDefined();
    expect(state2.bees.get(beeId)?.publicKey).toBe(publicKeyPem);
    expect([...state2.sessions.values()].some((s) => s.beeId === beeId)).toBe(true);

    const server2 = createHiveServer({ state: state2 });
    server2.listen(0, "127.0.0.1");
    await once(server2, "listening");
    const addr2 = server2.address();
    if (!addr2 || typeof addr2 !== "object") throw new Error("no addr");
    const baseUrl2 = `http://127.0.0.1:${addr2.port}`;

    const beesRes = await fetch(`${baseUrl2}/api/bees`);
    const body = (await beesRes.json()) as { bees: Array<{ beeId: string }> };
    expect(body.bees.some((b) => b.beeId === beeId)).toBe(true);

    server2.close();
  });
});
