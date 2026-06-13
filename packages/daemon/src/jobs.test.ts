import { EventEmitter } from "node:events";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { Job } from "@hiveplane/protocol";
import { loadOrCreateBeeIdentity } from "./identity.js";
import { JobExecutor } from "./jobs.js";
import type { HiveSession } from "./session.js";

async function makeIdentity() {
  const dir = mkdtempSync(join(tmpdir(), "hp-id-"));
  return await loadOrCreateBeeIdentity({ configDir: dir });
}

function makeSession(): HiveSession {
  return {
    hiveUrl: "http://hive.example/",
    beeId: "bee_test",
    sessionToken: "hp_sess_unit_test",
    sessionExpiresAt: new Date(Date.now() + 60_000).toISOString(),
  };
}

function makeJob(overrides: Partial<Job> = {}): Job {
  return {
    id: "job_1",
    type: "run_command",
    beeId: "bee_test",
    status: "assigned",
    payload: { command: "echo", args: ["hi"] },
    createdAt: new Date().toISOString(),
    ...overrides,
  } as Job;
}

class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
}

function makeSpawn(opts: {
  stdoutChunks?: string[];
  stderrChunks?: string[];
  exitCode?: number;
  errorAt?: number; // ms
}) {
  return vi.fn(() => {
    const child = new FakeChild();
    setImmediate(() => {
      for (const chunk of opts.stdoutChunks ?? []) {
        child.stdout.emit("data", Buffer.from(chunk));
      }
      for (const chunk of opts.stderrChunks ?? []) {
        child.stderr.emit("data", Buffer.from(chunk));
      }
      if (opts.errorAt !== undefined) {
        setTimeout(() => child.emit("error", new Error("spawn boom")), opts.errorAt);
      } else {
        child.emit("close", opts.exitCode ?? 0, null);
      }
    });
    return child as unknown as ReturnType<typeof import("node:child_process").spawn>;
  });
}

describe("JobExecutor", () => {
  it("denies a run_command not on the allowlist and reports failure", async () => {
    const identity = await makeIdentity();
    const session = makeSession();
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 200 }));

    const executor = new JobExecutor({
      hiveUrl: session.hiveUrl,
      session,
      identity,
      daemonVersion: "0.0.1-test",
      policy: { runCommand: { allow: [], unsafeAllowAll: false } },
      fetchImpl: fetchImpl as unknown as typeof fetch,
      spawnImpl: makeSpawn({}) as unknown as typeof import("node:child_process").spawn,
    });

    await executor.execute(makeJob({ payload: { command: "rm", args: ["-rf", "/"] } }));

    // First fetch is the policy.denied event; last fetch is the failure complete.
    const calls = fetchImpl.mock.calls;
    expect(calls.length).toBeGreaterThanOrEqual(2);
    const lastCall = calls[calls.length - 1] as unknown as [URL, RequestInit];
    expect(String(lastCall[0])).toMatch(/\/api\/jobs\/job_1\/complete$/);
    const completeBody = JSON.parse(Buffer.from(lastCall[1].body as Uint8Array).toString("utf8"));
    expect(completeBody.status).toBe("failed");
    expect(completeBody.error.code).toBe("policy_denied");
  });

  it("runs an allowed command, streams stdout events, completes succeeded", async () => {
    const identity = await makeIdentity();
    const session = makeSession();
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 200 }));

    const executor = new JobExecutor({
      hiveUrl: session.hiveUrl,
      session,
      identity,
      daemonVersion: "0.0.1-test",
      policy: { runCommand: { allow: ["echo"], unsafeAllowAll: false } },
      fetchImpl: fetchImpl as unknown as typeof fetch,
      spawnImpl: makeSpawn({
        stdoutChunks: ["hello\n"],
        exitCode: 0,
      }) as unknown as typeof import("node:child_process").spawn,
    });

    await executor.execute(makeJob({ payload: { command: "echo", args: ["hello"] } }));

    const calls = fetchImpl.mock.calls;
    // command.start event, command.stdout event, complete
    expect(calls.length).toBeGreaterThanOrEqual(2);
    const lastCall = calls[calls.length - 1] as unknown as [URL, RequestInit];
    expect(String(lastCall[0])).toMatch(/\/api\/jobs\/job_1\/complete$/);
    const completeBody = JSON.parse(Buffer.from(lastCall[1].body as Uint8Array).toString("utf8"));
    expect(completeBody.status).toBe("succeeded");
    expect(completeBody.output.exitCode).toBe(0);
    expect(completeBody.output.stdout).toContain("hello");
  });

  it("reloads local policy at execution time", async () => {
    const configDir = mkdtempSync(join(tmpdir(), "hp-policy-"));
    const identity = await loadOrCreateBeeIdentity({ configDir });
    const session = makeSession();
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 200 }));
    const spawnImpl = makeSpawn({
      stdoutChunks: ["hello\n"],
      exitCode: 0,
    }) as unknown as typeof import("node:child_process").spawn;

    const executor = new JobExecutor({
      hiveUrl: session.hiveUrl,
      session,
      identity,
      configDir,
      daemonVersion: "0.0.1-test",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      spawnImpl,
    });

    writeFileSync(
      join(configDir, "policy.json"),
      JSON.stringify({ runCommand: { allow: ["echo"] } }),
    );
    await executor.execute(makeJob({ payload: { command: "echo", args: ["hello"] } }));

    expect(spawnImpl).toHaveBeenCalledWith(
      "echo",
      ["hello"],
      expect.objectContaining({ stdio: ["ignore", "pipe", "pipe"] }),
    );
  });

  it("non-zero exit reports failed with the exit code", async () => {
    const identity = await makeIdentity();
    const session = makeSession();
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 200 }));

    const executor = new JobExecutor({
      hiveUrl: session.hiveUrl,
      session,
      identity,
      daemonVersion: "0.0.1-test",
      policy: { runCommand: { allow: ["false"], unsafeAllowAll: false } },
      fetchImpl: fetchImpl as unknown as typeof fetch,
      spawnImpl: makeSpawn({ exitCode: 1 }) as unknown as typeof import("node:child_process").spawn,
    });

    await executor.execute(makeJob({ payload: { command: "false" } }));

    const calls = fetchImpl.mock.calls;
    const lastCall = calls[calls.length - 1] as unknown as [URL, RequestInit];
    const body = JSON.parse(Buffer.from(lastCall[1].body as Uint8Array).toString("utf8"));
    expect(body.status).toBe("failed");
    expect(body.error.code).toBe("non_zero_exit");
    expect(body.error.exitCode).toBe(1);
  });

  it("reports unsupported job types as failed", async () => {
    const identity = await makeIdentity();
    const session = makeSession();
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 200 }));

    const executor = new JobExecutor({
      hiveUrl: session.hiveUrl,
      session,
      identity,
      daemonVersion: "0.0.1-test",
      policy: { runCommand: { allow: [], unsafeAllowAll: false } },
      fetchImpl: fetchImpl as unknown as typeof fetch,
      spawnImpl: makeSpawn({}) as unknown as typeof import("node:child_process").spawn,
    });

    await executor.execute(makeJob({ type: "install_runtime", payload: { runtime: "ollama" } }));

    const lastCall = fetchImpl.mock.calls[fetchImpl.mock.calls.length - 1] as unknown as [
      URL,
      RequestInit,
    ];
    const body = JSON.parse(Buffer.from(lastCall[1].body as Uint8Array).toString("utf8"));
    expect(body.status).toBe("failed");
    expect(body.error.code).toBe("unsupported_job_type");
  });

  it("run_healthcheck succeeds with daemon info", async () => {
    const identity = await makeIdentity();
    const session = makeSession();
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 200 }));

    const executor = new JobExecutor({
      hiveUrl: session.hiveUrl,
      session,
      identity,
      daemonVersion: "0.0.1-test",
      policy: { runCommand: { allow: [], unsafeAllowAll: false } },
      fetchImpl: fetchImpl as unknown as typeof fetch,
      spawnImpl: makeSpawn({}) as unknown as typeof import("node:child_process").spawn,
    });

    await executor.execute(makeJob({ type: "run_healthcheck", payload: {} }));

    const lastCall = fetchImpl.mock.calls[fetchImpl.mock.calls.length - 1] as unknown as [
      URL,
      RequestInit,
    ];
    const body = JSON.parse(Buffer.from(lastCall[1].body as Uint8Array).toString("utf8"));
    expect(body.status).toBe("succeeded");
    expect(body.output.daemonVersion).toBe("0.0.1-test");
    expect(body.output.beeId).toBe("bee_test");
  });
});
