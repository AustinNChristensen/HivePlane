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
  killed = false;
  kill = vi.fn((signal?: NodeJS.Signals) => {
    this.killed = true;
    setImmediate(() => this.emit("close", null, signal ?? "SIGTERM"));
    return true;
  });
}

function makeSpawn(opts: {
  stdoutChunks?: string[];
  stderrChunks?: string[];
  exitCode?: number;
  errorAt?: number; // ms
  closeDelayMs?: number;
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
        setTimeout(() => {
          if (!child.killed) child.emit("close", opts.exitCode ?? 0, null);
        }, opts.closeDelayMs ?? 0);
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
      policy: {
        runCommand: { allow: [], deny: [], requireApproval: [], unsafeAllowAll: false },
        jobs: { allow: [], deny: [], requireApproval: [] },
      },
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

  it("emits approval_required and does not run dangerous jobs without local approval", async () => {
    const identity = await makeIdentity();
    const session = makeSession();
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 200 }));
    const spawnImpl = makeSpawn({
      stdoutChunks: ["should-not-run\n"],
      exitCode: 0,
    }) as unknown as typeof import("node:child_process").spawn;

    const executor = new JobExecutor({
      hiveUrl: session.hiveUrl,
      session,
      identity,
      daemonVersion: "0.0.1-test",
      policy: {
        runCommand: { allow: [], deny: [], requireApproval: [], unsafeAllowAll: false },
        jobs: { allow: [], deny: [], requireApproval: [] },
      },
      fetchImpl: fetchImpl as unknown as typeof fetch,
      spawnImpl,
    });

    await executor.execute(
      makeJob({
        type: "install_runtime",
        payload: {
          recipe: {
            id: "safe-example",
            name: "Safe example",
            version: "1",
            steps: [{ id: "install", run: { command: "echo", args: ["installed"] } }],
          },
        },
      }),
    );

    expect(spawnImpl).not.toHaveBeenCalled();
    const eventBodies = fetchImpl.mock.calls
      .map((call) => {
        const [, init] = call as unknown as [URL, RequestInit];
        return JSON.parse(Buffer.from(init.body as Uint8Array).toString("utf8"));
      })
      .filter((body) => Array.isArray(body.events));
    expect(JSON.stringify(eventBodies)).toContain("approval_required");

    const lastCall = fetchImpl.mock.calls[fetchImpl.mock.calls.length - 1] as unknown as [
      URL,
      RequestInit,
    ];
    const body = JSON.parse(Buffer.from(lastCall[1].body as Uint8Array).toString("utf8"));
    expect(body.status).toBe("failed");
    expect(body.error.code).toBe("approval_required");
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

  it("kills a running command when the job is cancelled", async () => {
    const identity = await makeIdentity();
    const session = makeSession();
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 200 }));
    let child: FakeChild | undefined;
    const spawnImpl = vi.fn(() => {
      child = new FakeChild();
      return child as unknown as ReturnType<typeof import("node:child_process").spawn>;
    });
    const controller = new AbortController();

    const executor = new JobExecutor({
      hiveUrl: session.hiveUrl,
      session,
      identity,
      daemonVersion: "0.0.1-test",
      policy: { runCommand: { allow: ["sleep"], unsafeAllowAll: false } },
      fetchImpl: fetchImpl as unknown as typeof fetch,
      spawnImpl: spawnImpl as unknown as typeof import("node:child_process").spawn,
    });

    const running = executor.execute(
      makeJob({ payload: { command: "sleep", args: ["30"] } }),
      controller.signal,
    );
    controller.abort("unit-test cancellation");
    await running;

    expect(child?.kill).toHaveBeenCalledWith("SIGTERM");
    const lastCall = fetchImpl.mock.calls[fetchImpl.mock.calls.length - 1] as unknown as [
      URL,
      RequestInit,
    ];
    const completeBody = JSON.parse(Buffer.from(lastCall[1].body as Uint8Array).toString("utf8"));
    expect(completeBody.status).toBe("cancelled");
    expect(completeBody.error.code).toBe("job_cancelled");
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
      policy: {
        runCommand: { allow: [], unsafeAllowAll: false },
        jobs: { allow: ["update_bee"] },
      },
      fetchImpl: fetchImpl as unknown as typeof fetch,
      spawnImpl: makeSpawn({}) as unknown as typeof import("node:child_process").spawn,
    });

    await executor.execute(makeJob({ type: "restart_bee", payload: {} }));

    const lastCall = fetchImpl.mock.calls[fetchImpl.mock.calls.length - 1] as unknown as [
      URL,
      RequestInit,
    ];
    const body = JSON.parse(Buffer.from(lastCall[1].body as Uint8Array).toString("utf8"));
    expect(body.status).toBe("failed");
    expect(body.error.code).toBe("unsupported_job_type");
  });

  it("dry-runs install_runtime recipes without spawning commands", async () => {
    const identity = await makeIdentity();
    const session = makeSession();
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 200 }));
    const spawnImpl = makeSpawn({}) as unknown as typeof import("node:child_process").spawn;

    const executor = new JobExecutor({
      hiveUrl: session.hiveUrl,
      session,
      identity,
      daemonVersion: "0.0.1-test",
      policy: {
        runCommand: { allow: [], deny: [], requireApproval: [], unsafeAllowAll: false },
        jobs: { allow: ["install_runtime"], deny: [], requireApproval: [] },
      },
      fetchImpl: fetchImpl as unknown as typeof fetch,
      spawnImpl,
    });

    await executor.execute(
      makeJob({
        type: "install_runtime",
        payload: {
          dryRun: true,
          recipe: {
            id: "safe-example",
            name: "Safe example",
            version: "1",
            steps: [{ id: "echo", run: { command: "echo", args: ["hello"] } }],
          },
        },
      }),
    );

    expect(spawnImpl).not.toHaveBeenCalled();
    const lastCall = fetchImpl.mock.calls[fetchImpl.mock.calls.length - 1] as unknown as [
      URL,
      RequestInit,
    ];
    const body = JSON.parse(Buffer.from(lastCall[1].body as Uint8Array).toString("utf8"));
    expect(body.status).toBe("succeeded");
    expect(body.output.dryRun).toBe(true);
    expect(body.output.plannedSteps[0]).toMatchObject({ id: "echo", command: "echo" });
  });

  it("executes install_runtime recipes and streams recipe events", async () => {
    const identity = await makeIdentity();
    const session = makeSession();
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 200 }));
    const spawnImpl = makeSpawn({
      stdoutChunks: ["installed\n"],
      exitCode: 0,
    }) as unknown as typeof import("node:child_process").spawn;

    const executor = new JobExecutor({
      hiveUrl: session.hiveUrl,
      session,
      identity,
      daemonVersion: "0.0.1-test",
      policy: {
        runCommand: { allow: [], deny: [], requireApproval: [], unsafeAllowAll: false },
        jobs: { allow: ["install_runtime"], deny: [], requireApproval: [] },
      },
      fetchImpl: fetchImpl as unknown as typeof fetch,
      spawnImpl,
    });

    await executor.execute(
      makeJob({
        type: "install_runtime",
        payload: {
          recipe: {
            id: "safe-example",
            name: "Safe example",
            version: "1",
            steps: [{ id: "install", run: { command: "echo", args: ["installed"] } }],
          },
        },
      }),
    );

    const eventBodies = fetchImpl.mock.calls
      .map((call) => {
        const [, init] = call as unknown as [URL, RequestInit];
        return JSON.parse(Buffer.from(init.body as Uint8Array).toString("utf8"));
      })
      .filter((body) => Array.isArray(body.events));
    expect(JSON.stringify(eventBodies)).toContain("recipe.step.stdout");

    const lastCall = fetchImpl.mock.calls[fetchImpl.mock.calls.length - 1] as unknown as [
      URL,
      RequestInit,
    ];
    const body = JSON.parse(Buffer.from(lastCall[1].body as Uint8Array).toString("utf8"));
    expect(body.status).toBe("succeeded");
    expect(body.output.steps[0].stdout).toContain("installed");
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
      policy: {
        runCommand: { allow: [], unsafeAllowAll: false },
        jobs: { allow: ["update_bee"] },
      },
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

  it("accepts scaffolded Hive sub-agent tasks", async () => {
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

    await executor.execute(
      makeJob({
        type: "agent_task",
        payload: {
          taskId: "task_123",
          title: "Summarize repo",
          instructions: "Find the important files.",
        },
      }),
    );

    const lastCall = fetchImpl.mock.calls[fetchImpl.mock.calls.length - 1] as unknown as [
      URL,
      RequestInit,
    ];
    const body = JSON.parse(Buffer.from(lastCall[1].body as Uint8Array).toString("utf8"));
    expect(body.status).toBe("succeeded");
    expect(body.output).toMatchObject({
      taskId: "task_123",
      title: "Summarize repo",
      runtime: "scaffold",
    });
  });

  it("runs OpenClaw-backed Hive sub-agent tasks", async () => {
    const identity = await makeIdentity();
    const session = makeSession();
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 200 }));
    const spawnImpl = makeSpawn({
      stdoutChunks: [
        JSON.stringify({
          runId: "run_123",
          status: "ok",
          summary: "completed",
          result: {
            payloads: [{ text: "done" }],
            meta: {
              durationMs: 1234,
              agentMeta: {
                sessionId: "sess_123",
                provider: "openai",
                model: "gpt-test",
                agentHarnessId: "codex",
                usage: { input: 10, output: 2, total: 12 },
                verboseInternalBlob: "drop me",
              },
              systemPromptReport: { shouldNotPersist: true },
            },
          },
        }) + "\n",
      ],
      stderrChunks: ["\u001b[?25lprogress\u0000\n"],
      exitCode: 0,
    }) as unknown as typeof import("node:child_process").spawn;

    const executor = new JobExecutor({
      hiveUrl: session.hiveUrl,
      session,
      identity,
      daemonVersion: "0.0.1-test",
      policy: { runCommand: { allow: [], unsafeAllowAll: false } },
      fetchImpl: fetchImpl as unknown as typeof fetch,
      spawnImpl,
      openclawPathOverride: "/tmp/openclaw-test",
    });

    await executor.execute(
      makeJob({
        type: "agent_task",
        timeoutSeconds: 120,
        payload: {
          taskId: "task_openclaw",
          title: "Summarize repo",
          instructions: "Find the important files.",
          requestedBy: "unit-test",
          requirements: { runtimes: ["openclaw"], tools: [], models: [] },
        },
      }),
    );

    expect(spawnImpl).toHaveBeenCalledWith(
      "/tmp/openclaw-test",
      expect.arrayContaining([
        "agent",
        "--session-key",
        "hiveplane-task-task_openclaw",
        "--json",
        "--timeout",
        "120",
      ]),
      expect.objectContaining({ stdio: ["ignore", "pipe", "pipe"] }),
    );
    const lastCall = fetchImpl.mock.calls[fetchImpl.mock.calls.length - 1] as unknown as [
      URL,
      RequestInit,
    ];
    const body = JSON.parse(Buffer.from(lastCall[1].body as Uint8Array).toString("utf8"));
    expect(body.status).toBe("succeeded");
    expect(body.output).toMatchObject({
      taskId: "task_openclaw",
      title: "Summarize repo",
      runtime: "openclaw",
      sessionKey: "hiveplane-task-task_openclaw",
      result: {
        runId: "run_123",
        status: "ok",
        summary: "completed",
        finalText: "done",
        durationMs: 1234,
        agent: {
          sessionId: "sess_123",
          provider: "openai",
          model: "gpt-test",
          harness: "codex",
          usage: { input: 10, output: 2, total: 12 },
        },
      },
    });
    expect(body.output.result.agent.verboseInternalBlob).toBeUndefined();
    expect(body.output.result.systemPromptReport).toBeUndefined();
    expect(body.output.stderr).toBe("progress\n");
    const eventBodies = (fetchImpl.mock.calls as unknown as Array<[URL, RequestInit]>)
      .map((call) => JSON.parse(Buffer.from(call[1].body as Uint8Array).toString("utf8")))
      .filter((payload) => payload.type === "job.events.append");
    expect(JSON.stringify(eventBodies)).not.toContain("\u001b");
    expect(JSON.stringify(eventBodies)).not.toContain("\u0000");
    expect(eventBodies).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          events: expect.arrayContaining([
            expect.objectContaining({
              type: "agent_task.openclaw.stderr",
              data: { text: "progress\n" },
            }),
          ]),
        }),
      ]),
    );
  });

  it("openclaw_status completes through the adapter path", async () => {
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

    await executor.execute(makeJob({ type: "openclaw_status", payload: {} }));

    const lastCall = fetchImpl.mock.calls[fetchImpl.mock.calls.length - 1] as unknown as [
      URL,
      RequestInit,
    ];
    const body = JSON.parse(Buffer.from(lastCall[1].body as Uint8Array).toString("utf8"));
    expect(body.status).toBe("succeeded");
    expect(typeof body.output.installed).toBe("boolean");
  });

  it("ollama_list_models completes through the adapter path", async () => {
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

    await executor.execute(makeJob({ type: "ollama_list_models", payload: {} }));

    const lastCall = fetchImpl.mock.calls[fetchImpl.mock.calls.length - 1] as unknown as [
      URL,
      RequestInit,
    ];
    const body = JSON.parse(Buffer.from(lastCall[1].body as Uint8Array).toString("utf8"));
    expect(body.status).toBe("succeeded");
    expect(Array.isArray(body.output.models)).toBe(true);
  });

  it("configure_model pulls Ollama models with progress events", async () => {
    const identity = await makeIdentity();
    const session = makeSession();
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 200 }));
    const spawnImpl = makeSpawn({
      stdoutChunks: ["pulling manifest\n", "success\n"],
      exitCode: 0,
    }) as unknown as typeof import("node:child_process").spawn;

    const executor = new JobExecutor({
      hiveUrl: session.hiveUrl,
      session,
      identity,
      daemonVersion: "0.0.1-test",
      policy: {
        runCommand: { allow: [], unsafeAllowAll: false },
        jobs: { allow: ["configure_model"] },
      },
      fetchImpl: fetchImpl as unknown as typeof fetch,
      spawnImpl,
      ollamaPathOverride: "/usr/local/bin/ollama",
    });

    await executor.execute(
      makeJob({
        type: "configure_model",
        payload: { backend: "ollama", model: "qwen2.5-coder:7b" },
      }),
    );

    expect(spawnImpl).toHaveBeenCalledWith(
      "/usr/local/bin/ollama",
      ["pull", "qwen2.5-coder:7b"],
      expect.objectContaining({ stdio: ["ignore", "pipe", "pipe"] }),
    );
    const eventBodies = fetchImpl.mock.calls
      .map((call) => {
        const [, init] = call as unknown as [URL, RequestInit];
        return JSON.parse(Buffer.from(init.body as Uint8Array).toString("utf8"));
      })
      .filter((body) => Array.isArray(body.events));
    expect(JSON.stringify(eventBodies)).toContain("ollama.pull.stdout");

    const lastCall = fetchImpl.mock.calls[fetchImpl.mock.calls.length - 1] as unknown as [
      URL,
      RequestInit,
    ];
    const body = JSON.parse(Buffer.from(lastCall[1].body as Uint8Array).toString("utf8"));
    expect(body.status).toBe("succeeded");
    expect(body.output).toMatchObject({
      backend: "ollama",
      model: "qwen2.5-coder:7b",
      endpointUrl: "http://127.0.0.1:11434",
    });
    expect(body.output.stdout).toContain("success");
  });

  it("update_bee fetches, hard-resets stale checkouts, and installs deps before completing", async () => {
    const identity = await makeIdentity();
    const session = makeSession();
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 200 }));
    const spawnImpl = makeSpawn({
      stdoutChunks: ["ok\n"],
      exitCode: 0,
    }) as unknown as typeof import("node:child_process").spawn;

    const executor = new JobExecutor({
      hiveUrl: session.hiveUrl,
      session,
      identity,
      daemonVersion: "0.0.1-test",
      policy: {
        runCommand: { allow: [], unsafeAllowAll: false },
        jobs: { allow: ["update_bee"] },
      },
      fetchImpl: fetchImpl as unknown as typeof fetch,
      spawnImpl,
      scheduleRestart: false,
    });

    await executor.execute(
      makeJob({ type: "update_bee", payload: { installDir: "/tmp/hiveplane" } }),
    );

    expect(spawnImpl).toHaveBeenNthCalledWith(
      1,
      "git",
      ["fetch", "--prune", "origin", "main"],
      expect.objectContaining({ cwd: "/tmp/hiveplane" }),
    );
    expect(spawnImpl).toHaveBeenNthCalledWith(
      2,
      "git",
      ["reset", "--hard", "origin/main"],
      expect.objectContaining({ cwd: "/tmp/hiveplane" }),
    );
    expect(spawnImpl).toHaveBeenNthCalledWith(
      3,
      "pnpm",
      ["install", "--frozen-lockfile", "--silent"],
      expect.objectContaining({ cwd: "/tmp/hiveplane" }),
    );
    const lastCall = fetchImpl.mock.calls[fetchImpl.mock.calls.length - 1] as unknown as [
      URL,
      RequestInit,
    ];
    const body = JSON.parse(Buffer.from(lastCall[1].body as Uint8Array).toString("utf8"));
    expect(body.status).toBe("succeeded");
    expect(body.output.ref).toBe("main");
    expect(body.output.restartScheduled).toBe(true);
  });
});
