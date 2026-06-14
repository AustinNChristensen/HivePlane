import { spawn } from "node:child_process";
import { sign as edSign } from "node:crypto";
import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { userInfo } from "node:os";
import {
  JobCompleteRequestSchema,
  JobEventBatchSchema,
  type Job,
  type JobEvent,
  type JsonValue,
} from "@hiveplane/protocol";
import {
  getOllamaStatus,
  getOpenClawStatus,
  listOllamaModels,
  runtimeStatusToJson,
} from "./capabilities.js";
import type { BeeIdentity } from "./identity.js";
import type { HiveSession } from "./session.js";
import { policyAllowsCommand, readBeePolicy, type BeePolicy } from "./policy.js";

export type JobExecutorOptions = {
  hiveUrl: string;
  session: HiveSession;
  identity: BeeIdentity;
  policy?: BeePolicy;
  configDir?: string;
  daemonVersion: string;
  fetchImpl?: typeof fetch;
  /** Override for tests. Defaults to spawning a real child process. */
  spawnImpl?: typeof spawn;
  scheduleRestart?: boolean;
};

export type JobOutcome =
  | { status: "succeeded"; output?: Record<string, JsonValue> }
  | { status: "failed"; error: Record<string, JsonValue> };

export class JobExecutor {
  private readonly fetchImpl: typeof fetch;
  private readonly spawnImpl: typeof spawn;
  private sequence = 0;

  constructor(private readonly options: JobExecutorOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.spawnImpl = options.spawnImpl ?? spawn;
  }

  async execute(job: Job): Promise<void> {
    let outcome: JobOutcome;
    try {
      switch (job.type) {
        case "run_command":
          outcome = await this.runCommand(job);
          break;
        case "run_healthcheck":
          outcome = await this.runHealthcheck(job);
          break;
        case "openclaw_status":
          outcome = await this.runOpenClawStatus(job);
          break;
        case "ollama_status":
          outcome = await this.runOllamaStatus(job);
          break;
        case "ollama_list_models":
          outcome = await this.runOllamaListModels(job);
          break;
        case "update_bee":
          outcome = await this.runBeeUpdate(job);
          break;
        case "agent_task":
          outcome = await this.runAgentTask(job);
          break;
        default:
          outcome = {
            status: "failed",
            error: {
              code: "unsupported_job_type",
              message: `Bee daemon v0.0.1 does not implement '${job.type}' yet`,
            },
          };
      }
    } catch (error) {
      outcome = {
        status: "failed",
        error: {
          code: "executor_threw",
          message: error instanceof Error ? error.message : String(error),
        },
      };
    }

    await this.complete(job, outcome);
    if (
      job.type === "update_bee" &&
      outcome.status === "succeeded" &&
      this.options.scheduleRestart !== false
    ) {
      this.scheduleBeeRestart();
    }
  }

  private async runCommand(job: Job): Promise<JobOutcome> {
    const command = typeof job.payload.command === "string" ? job.payload.command : "";
    const args = Array.isArray(job.payload.args)
      ? job.payload.args.filter((a): a is string => typeof a === "string")
      : [];

    const decision = policyAllowsCommand(this.getPolicy(), command);
    if (!decision.allowed) {
      await this.emit(job, "info", "policy.denied", { command, reason: decision.reason });
      return { status: "failed", error: { code: "policy_denied", message: decision.reason } };
    }

    await this.emit(job, "info", "command.start", { command, args });

    const child = this.spawnImpl(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });

    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];
    const pendingEventPosts: Promise<void>[] = [];
    const queueEvent = (
      level: JobEvent["level"],
      type: string,
      data: Record<string, JsonValue>,
    ) => {
      const post = this.emit(job, level, type, data).catch((error) => {
        stderrChunks.push(
          `[hiveplane] failed to stream ${type}: ${
            error instanceof Error ? error.message : String(error)
          }\n`,
        );
      });
      pendingEventPosts.push(post);
    };

    child.stdout?.on("data", (data: Buffer) => {
      const text = data.toString("utf8");
      stdoutChunks.push(text);
      queueEvent("debug", "command.stdout", { text });
    });
    child.stderr?.on("data", (data: Buffer) => {
      const text = data.toString("utf8");
      stderrChunks.push(text);
      queueEvent("debug", "command.stderr", { text });
    });

    return await new Promise<JobOutcome>((resolve) => {
      child.once("error", (err) => {
        resolve({
          status: "failed",
          error: { code: "spawn_error", message: err.message },
        });
      });
      child.once("close", async (exitCode, signal) => {
        await Promise.allSettled(pendingEventPosts);
        const ok = exitCode === 0;
        const summary = {
          exitCode: exitCode ?? -1,
          signal: signal ?? null,
          stdout: stdoutChunks.join(""),
          stderr: stderrChunks.join(""),
        };
        if (ok) {
          resolve({ status: "succeeded", output: summary as Record<string, JsonValue> });
        } else {
          resolve({
            status: "failed",
            error: {
              code: "non_zero_exit",
              message: `exit code ${exitCode}${signal ? ` (signal ${signal})` : ""}`,
              ...summary,
            } as Record<string, JsonValue>,
          });
        }
      });
    });
  }

  private async runHealthcheck(job: Job): Promise<JobOutcome> {
    await this.emit(job, "info", "healthcheck.ok", { daemonVersion: this.options.daemonVersion });
    return {
      status: "succeeded",
      output: {
        daemonVersion: this.options.daemonVersion,
        beeId: this.options.session.beeId,
      },
    };
  }

  private async runOpenClawStatus(job: Job): Promise<JobOutcome> {
    await this.emit(job, "info", "openclaw.status.start", {});
    const status = await getOpenClawStatus();
    await this.emit(job, "info", "openclaw.status.result", runtimeStatusToJson(status));
    return { status: "succeeded", output: runtimeStatusToJson(status) };
  }

  private async runOllamaStatus(job: Job): Promise<JobOutcome> {
    await this.emit(job, "info", "ollama.status.start", {});
    const status = await getOllamaStatus();
    await this.emit(job, "info", "ollama.status.result", runtimeStatusToJson(status));
    return { status: "succeeded", output: runtimeStatusToJson(status) };
  }

  private async runOllamaListModels(job: Job): Promise<JobOutcome> {
    await this.emit(job, "info", "ollama.models.start", {});
    const result = await listOllamaModels();
    const output: Record<string, JsonValue> = {
      models: result.models,
      ...(result.message ? { message: result.message } : {}),
    };
    await this.emit(job, "info", "ollama.models.result", output);
    return { status: "succeeded", output };
  }

  private async runBeeUpdate(job: Job): Promise<JobOutcome> {
    const cwd = typeof job.payload.installDir === "string" ? job.payload.installDir : process.cwd();
    await this.emit(job, "info", "bee_update.start", { cwd });

    const git = await this.runUpdateCommand(job, "git", ["pull", "--ff-only"], cwd);
    if (!git.ok) return git.outcome;

    const install = await this.runUpdateCommand(
      job,
      "pnpm",
      ["install", "--frozen-lockfile", "--silent"],
      cwd,
    );
    if (!install.ok) return install.outcome;

    await this.emit(job, "info", "bee_update.restart_scheduled", {
      service: process.platform === "darwin" ? "com.hiveplane.bee" : "hiveplane-bee.service",
    });

    return {
      status: "succeeded",
      output: {
        cwd,
        git: git.summary,
        install: install.summary,
        restartScheduled: true,
      },
    };
  }

  private async runAgentTask(job: Job): Promise<JobOutcome> {
    const taskId = typeof job.payload.taskId === "string" ? job.payload.taskId : job.id;
    const title = typeof job.payload.title === "string" ? job.payload.title : "Hive task";
    const instructions =
      typeof job.payload.instructions === "string" ? job.payload.instructions : "";

    await this.emit(job, "info", "agent_task.accepted", { taskId, title });
    await this.emit(job, "info", "agent_task.scaffold", {
      message: "Bee accepted a Hive sub-agent task. Runtime-specific execution will be wired next.",
    });

    return {
      status: "succeeded",
      output: {
        taskId,
        title,
        instructions,
        runtime: "scaffold",
        message: "Hive sub-agent task accepted by Bee.",
      },
    };
  }

  private async runUpdateCommand(
    job: Job,
    command: string,
    args: string[],
    cwd: string,
  ): Promise<
    | { ok: true; summary: Record<string, JsonValue> }
    | { ok: false; outcome: Extract<JobOutcome, { status: "failed" }> }
  > {
    await this.emit(job, "info", "bee_update.command.start", { command, args });
    const child = this.spawnImpl(command, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });
    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];
    const pendingEventPosts: Promise<void>[] = [];
    const queueEvent = (level: JobEvent["level"], type: string, data: Record<string, JsonValue>) =>
      pendingEventPosts.push(this.emit(job, level, type, data));

    child.stdout?.on("data", (data: Buffer) => {
      const text = data.toString("utf8");
      stdoutChunks.push(text);
      queueEvent("debug", "bee_update.stdout", { command, text });
    });
    child.stderr?.on("data", (data: Buffer) => {
      const text = data.toString("utf8");
      stderrChunks.push(text);
      queueEvent("debug", "bee_update.stderr", { command, text });
    });

    return await new Promise((resolve) => {
      child.once("error", async (err) => {
        await Promise.allSettled(pendingEventPosts);
        resolve({
          ok: false,
          outcome: {
            status: "failed",
            error: { code: "update_spawn_error", command, message: err.message },
          },
        });
      });
      child.once("close", async (exitCode, signal) => {
        await Promise.allSettled(pendingEventPosts);
        const summary: Record<string, JsonValue> = {
          command,
          args,
          exitCode: exitCode ?? -1,
          signal: signal ?? null,
          stdout: stdoutChunks.join(""),
          stderr: stderrChunks.join(""),
        };
        if (exitCode === 0) {
          resolve({ ok: true, summary });
          return;
        }
        resolve({
          ok: false,
          outcome: {
            status: "failed",
            error: {
              code: "update_command_failed",
              message: `${command} exited ${exitCode}`,
              ...summary,
            },
          },
        });
      });
    });
  }

  private async emit(
    job: Job,
    level: JobEvent["level"],
    type: string,
    data: Record<string, JsonValue>,
  ): Promise<void> {
    this.sequence += 1;
    const batch = JobEventBatchSchema.parse({
      type: "job.events.append",
      jobId: job.id,
      beeId: this.options.session.beeId,
      events: [
        {
          id: `evt_${randomBytes(6).toString("hex")}`,
          jobId: job.id,
          beeId: this.options.session.beeId,
          sequence: this.sequence,
          type,
          level,
          actor: "bee",
          actorId: this.options.session.beeId,
          data,
          createdAt: new Date().toISOString(),
        },
      ],
    });
    const url = new URL(`/api/jobs/${job.id}/events`, this.options.hiveUrl);
    const rawBody = Buffer.from(JSON.stringify(batch));
    await this.signedFetch(url, rawBody);
  }

  private async complete(job: Job, outcome: JobOutcome): Promise<void> {
    const payload = JobCompleteRequestSchema.parse({
      type: "job.complete",
      jobId: job.id,
      beeId: this.options.session.beeId,
      status: outcome.status,
      ...(outcome.status === "succeeded" && outcome.output ? { output: outcome.output } : {}),
      ...(outcome.status === "failed" ? { error: outcome.error } : {}),
      completedAt: new Date().toISOString(),
    });
    const url = new URL(`/api/jobs/${job.id}/complete`, this.options.hiveUrl);
    const rawBody = Buffer.from(JSON.stringify(payload));
    await this.signedFetch(url, rawBody);
  }

  private async signedFetch(url: URL, rawBody: Buffer): Promise<void> {
    const privateKeyPem = readFileSync(this.options.identity.privateKeyPath, "utf8");
    const signature = edSign(null, rawBody, privateKeyPem).toString("base64url");

    const res = await this.fetchImpl(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.options.session.sessionToken}`,
        "x-bee-signature": signature,
      },
      body: new Uint8Array(rawBody),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`POST ${url.pathname} failed: ${res.status} ${text}`);
    }
  }

  private getPolicy(): BeePolicy {
    return this.options.policy ?? readBeePolicy(this.options.configDir);
  }

  private scheduleBeeRestart(): void {
    setTimeout(() => {
      if (process.platform === "darwin") {
        const uid = userInfo().uid;
        const child = spawn("launchctl", ["kickstart", "-k", `gui/${uid}/com.hiveplane.bee`], {
          detached: true,
          stdio: "ignore",
        });
        child.unref();
        return;
      }
      if (process.platform === "linux") {
        const child = spawn("systemctl", ["--user", "restart", "hiveplane-bee.service"], {
          detached: true,
          stdio: "ignore",
        });
        child.unref();
      }
    }, 1_000).unref();
  }
}
