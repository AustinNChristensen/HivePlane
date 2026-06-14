import { spawn, type ChildProcess } from "node:child_process";
import { sign as edSign } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
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
  deleteOpenClawSubAgentRegistry,
  getOpenClawSubAgentRegistryPath,
  getOllamaStatus,
  getOpenClawStatus,
  findOllamaExecutable,
  listOllamaModels,
  readOpenClawSubAgentRegistry,
  runtimeStatusToJson,
  upsertAgentSessionRegistry,
  upsertOpenClawSubAgentRegistry,
} from "./capabilities.js";
import type { BeeIdentity } from "./identity.js";
import type { HiveSession } from "./session.js";
import {
  policyAllowsCommand,
  policyDecisionForJob,
  readBeePolicy,
  type BeePolicy,
} from "./policy.js";
import { executeRecipe, RecipeSchema } from "./recipes.js";

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
  /** Override for tests. Production resolves the local OpenClaw binary from fixed paths. */
  openclawPathOverride?: string;
  /** Override for tests. Production resolves the local Ollama binary from fixed paths. */
  ollamaPathOverride?: string;
  /** Override for tests. Production resolves the local Homebrew binary from fixed paths. */
  brewPathOverride?: string;
  scheduleRestart?: boolean;
};

export type JobOutcome =
  | { status: "succeeded"; output?: Record<string, JsonValue> }
  | { status: "failed"; error: Record<string, JsonValue> }
  | { status: "cancelled"; error: Record<string, JsonValue> };

export class JobExecutor {
  private readonly fetchImpl: typeof fetch;
  private readonly spawnImpl: typeof spawn;
  private sequence = 0;

  constructor(private readonly options: JobExecutorOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.spawnImpl = options.spawnImpl ?? spawn;
  }

  async execute(job: Job, signal?: AbortSignal): Promise<void> {
    let outcome: JobOutcome;
    try {
      if (signal?.aborted) {
        outcome = cancelledOutcome(job);
        await this.complete(job, outcome);
        return;
      }
      const policyDecision = policyDecisionForJob(this.getPolicy(), job);
      if (!policyDecision.allowed) {
        if (policyDecision.requiresApproval) {
          await this.emit(job, "warn", "approval_required", {
            jobType: job.type,
            reason: policyDecision.reason,
            risk: policyDecision.risk ?? "write",
          });
          outcome = {
            status: "failed",
            error: {
              code: "approval_required",
              message: policyDecision.reason,
              risk: policyDecision.risk ?? "write",
            },
          };
        } else {
          await this.emit(job, "info", "policy.denied", {
            jobType: job.type,
            reason: policyDecision.reason,
          });
          outcome = {
            status: "failed",
            error: { code: "policy_denied", message: policyDecision.reason },
          };
        }
        await this.complete(job, outcome);
        return;
      }
      switch (job.type) {
        case "run_command":
          outcome = await this.runCommand(job, signal);
          break;
        case "run_healthcheck":
          outcome = await this.runHealthcheck(job);
          break;
        case "openclaw_status":
          outcome = await this.runOpenClawStatus(job);
          break;
        case "openclaw_subagents_list":
          outcome = await this.runOpenClawSubAgentsList(job);
          break;
        case "openclaw_subagent_configure":
          outcome = await this.runOpenClawSubAgentConfigure(job);
          break;
        case "openclaw_subagent_delete":
          outcome = await this.runOpenClawSubAgentDelete(job);
          break;
        case "openclaw_subagent_smoke_test":
          outcome = await this.runOpenClawSubAgentSmokeTest(job, signal);
          break;
        case "ollama_status":
          outcome = await this.runOllamaStatus(job);
          break;
        case "ollama_list_models":
          outcome = await this.runOllamaListModels(job);
          break;
        case "ollama_start":
          outcome = await this.runOllamaStart(job, signal);
          break;
        case "ollama_pull_model":
          outcome = await this.runOllamaPullModel(job, signal);
          break;
        case "ollama_smoke_test":
          outcome = await this.runOllamaSmokeTest(job, signal);
          break;
        case "update_bee":
          outcome = await this.runBeeUpdate(job, signal);
          break;
        case "install_runtime":
          outcome = await this.runInstallRuntime(job, signal);
          break;
        case "install_model_backend":
          outcome = await this.runInstallModelBackend(job, signal);
          break;
        case "configure_model":
          outcome = await this.runConfigureModel(job, signal);
          break;
        case "agent_task":
          outcome = await this.runAgentTask(job, signal);
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

  private async runCommand(job: Job, signal?: AbortSignal): Promise<JobOutcome> {
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
    const cleanupCancellation = attachChildCancellation(child, signal);

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
        cleanupCancellation();
        resolve({
          status: "failed",
          error: { code: "spawn_error", message: err.message },
        });
      });
      child.once("close", async (exitCode, exitSignal) => {
        cleanupCancellation();
        await Promise.allSettled(pendingEventPosts);
        const ok = exitCode === 0;
        const summary = {
          exitCode: exitCode ?? -1,
          signal: exitSignal ?? null,
          stdout: stdoutChunks.join(""),
          stderr: stderrChunks.join(""),
        };
        if (ok) {
          resolve({ status: "succeeded", output: summary as Record<string, JsonValue> });
        } else if (exitSignal && signal?.aborted) {
          resolve(cancelledOutcome(job, exitSignal));
        } else {
          resolve({
            status: "failed",
            error: {
              code: exitSignal ? "process_signalled" : "non_zero_exit",
              message: `exit code ${exitCode}${exitSignal ? ` (signal ${exitSignal})` : ""}`,
              ...summary,
            } as Record<string, JsonValue>,
          });
        }
      });
    });
  }

  private async runStreamingProcess(
    job: Job,
    command: string,
    args: string[],
    signal: AbortSignal | undefined,
    eventTypes: { stdout: string; stderr: string },
  ): Promise<Extract<JobOutcome, { status: "succeeded" | "failed" | "cancelled" }>> {
    const child = this.spawnImpl(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });
    const cleanupCancellation = attachChildCancellation(child, signal);
    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];
    const pendingEventPosts: Promise<void>[] = [];
    const queueEvent = (
      level: JobEvent["level"],
      type: string,
      data: Record<string, JsonValue>,
    ) => {
      pendingEventPosts.push(this.emit(job, level, type, data));
    };

    child.stdout?.on("data", (data: Buffer) => {
      const text = sanitizeProcessText(data.toString("utf8"));
      stdoutChunks.push(text);
      queueEvent("debug", eventTypes.stdout, { text });
    });
    child.stderr?.on("data", (data: Buffer) => {
      const text = sanitizeProcessText(data.toString("utf8"));
      stderrChunks.push(text);
      queueEvent("debug", eventTypes.stderr, { text });
    });

    return await new Promise((resolve) => {
      child.once("error", (err) => {
        cleanupCancellation();
        resolve({
          status: "failed",
          error: { code: "spawn_error", message: err.message },
        });
      });
      child.once("close", async (exitCode, exitSignal) => {
        cleanupCancellation();
        await Promise.allSettled(pendingEventPosts);
        const summary = {
          exitCode: exitCode ?? -1,
          signal: exitSignal ?? null,
          stdout: stdoutChunks.join(""),
          stderr: stderrChunks.join(""),
        };
        if (exitCode === 0) {
          resolve({ status: "succeeded", output: summary as Record<string, JsonValue> });
        } else if (exitSignal && signal?.aborted) {
          resolve(cancelledOutcome(job, exitSignal));
        } else {
          resolve({
            status: "failed",
            error: {
              code: exitSignal ? "process_signalled" : "non_zero_exit",
              message: `exit code ${exitCode}${exitSignal ? ` (signal ${exitSignal})` : ""}`,
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

  private async runOpenClawSubAgentsList(job: Job): Promise<JobOutcome> {
    const subAgents = readOpenClawSubAgentRegistry(this.options.configDir);
    const output = {
      runtime: "openclaw",
      configPath: getOpenClawSubAgentRegistryPath(this.options.configDir),
      subAgents: subAgents.map(subAgentCapabilityToJson),
    };
    await this.emit(job, "info", "openclaw.subagents.list", {
      count: subAgents.length,
      configPath: output.configPath,
    });
    return { status: "succeeded", output };
  }

  private async runOpenClawSubAgentConfigure(job: Job): Promise<JobOutcome> {
    const id =
      typeof job.payload.id === "string" && job.payload.id.trim()
        ? job.payload.id.trim()
        : `subagent_${randomBytes(8).toString("hex")}`;
    const name =
      typeof job.payload.name === "string" && job.payload.name.trim()
        ? job.payload.name.trim()
        : id;
    const runtime =
      typeof job.payload.runtime === "string" && job.payload.runtime.trim()
        ? job.payload.runtime.trim()
        : "openclaw";
    if (runtime !== "openclaw") {
      return {
        status: "failed",
        error: {
          code: "unsupported_runtime",
          message: "openclaw_subagent_configure only supports runtime=openclaw",
        },
      };
    }

    const subAgent = {
      id,
      name,
      runtime,
      status: "configured" as const,
      ...(typeof job.payload.systemId === "string" && job.payload.systemId.trim()
        ? { systemId: job.payload.systemId.trim() }
        : {}),
      ...(typeof job.payload.modelProvider === "string" && job.payload.modelProvider.trim()
        ? { modelProvider: job.payload.modelProvider.trim() }
        : {}),
      ...(typeof job.payload.model === "string" && job.payload.model.trim()
        ? { model: job.payload.model.trim() }
        : {}),
      tools: readStringArray(job.payload.tools),
      skills: readStringArray(job.payload.skills),
      workingDirectories: readStringArray(job.payload.workingDirectories),
      updatedAt: new Date().toISOString(),
      metadata: readObject(job.payload.metadata) ?? {},
    };

    upsertOpenClawSubAgentRegistry(subAgent, this.options.configDir);
    await this.emit(job, "info", "openclaw.subagent.configured", {
      id: subAgent.id,
      name: subAgent.name,
      configPath: getOpenClawSubAgentRegistryPath(this.options.configDir),
    });
    return {
      status: "succeeded",
      output: {
        subAgent: subAgentCapabilityToJson(subAgent),
        configPath: getOpenClawSubAgentRegistryPath(this.options.configDir),
      },
    };
  }

  private async runOpenClawSubAgentDelete(job: Job): Promise<JobOutcome> {
    const id = typeof job.payload.id === "string" ? job.payload.id.trim() : "";
    if (!id) {
      return {
        status: "failed",
        error: { code: "missing_sub_agent_id", message: "openclaw_subagent_delete requires id" },
      };
    }
    const deleted = deleteOpenClawSubAgentRegistry(id, this.options.configDir);
    await this.emit(job, deleted ? "info" : "warn", "openclaw.subagent.deleted", { id, deleted });
    return {
      status: "succeeded",
      output: {
        id,
        deleted,
        configPath: getOpenClawSubAgentRegistryPath(this.options.configDir),
      },
    };
  }

  private async runOpenClawSubAgentSmokeTest(job: Job, signal?: AbortSignal): Promise<JobOutcome> {
    const id = typeof job.payload.id === "string" ? job.payload.id.trim() : "";
    if (!id) {
      return {
        status: "failed",
        error: {
          code: "missing_sub_agent_id",
          message: "openclaw_subagent_smoke_test requires id",
        },
      };
    }

    const subAgent = readOpenClawSubAgentRegistry(this.options.configDir).find(
      (candidate) => candidate.id === id,
    );
    if (!subAgent) {
      return {
        status: "failed",
        error: {
          code: "sub_agent_not_found",
          message: `OpenClaw sub-agent '${id}' is not configured`,
        },
      };
    }

    const openclawPath =
      this.options.openclawPathOverride ??
      findExecutable(["/opt/homebrew/bin/openclaw", "/usr/local/bin/openclaw"]);
    if (!openclawPath) {
      return {
        status: "failed",
        error: { code: "openclaw_not_found", message: "openclaw CLI not found on this Bee" },
      };
    }

    const timeoutSeconds = typeof job.timeoutSeconds === "number" ? job.timeoutSeconds : 120;
    const sessionKey = `hiveplane-subagent-${id}-smoke`;
    const result = await this.runStreamingProcess(
      job,
      openclawPath,
      [
        "agent",
        "--session-key",
        sessionKey,
        "--message",
        buildOpenClawSubAgentSmokePrompt(subAgent),
        "--json",
        "--timeout",
        String(timeoutSeconds),
      ],
      signal,
      { stdout: "openclaw.subagent_smoke.stdout", stderr: "openclaw.subagent_smoke.stderr" },
    );

    if (result.status === "succeeded") {
      return {
        status: "succeeded",
        output: {
          subAgentId: id,
          sessionKey,
          ...result.output,
        },
      };
    }
    return result;
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

  private async runOllamaStart(job: Job, signal?: AbortSignal): Promise<JobOutcome> {
    await this.emit(job, "info", "ollama.start.begin", {});
    const result = await this.startOllamaService(job, signal);
    if (result.status !== "succeeded") return result;
    const status = await getOllamaStatus();
    await this.emit(job, "info", "ollama.start.status", runtimeStatusToJson(status));
    return {
      status: "succeeded",
      output: {
        ...result.output,
        status: runtimeStatusToJson(status),
      },
    };
  }

  private async runOllamaPullModel(job: Job, signal?: AbortSignal): Promise<JobOutcome> {
    return await this.pullOllamaModel(job, signal);
  }

  private async runOllamaSmokeTest(job: Job, signal?: AbortSignal): Promise<JobOutcome> {
    const model = typeof job.payload.model === "string" ? job.payload.model.trim() : "";
    if (!model) {
      return {
        status: "failed",
        error: { code: "missing_model", message: "ollama_smoke_test requires payload.model" },
      };
    }
    const prompt =
      typeof job.payload.prompt === "string" && job.payload.prompt.trim()
        ? job.payload.prompt.trim()
        : "Reply with exactly: hiveplane-ollama-ok";
    const ollamaPath = this.options.ollamaPathOverride ?? findOllamaExecutable();
    if (!ollamaPath) {
      await this.emit(job, "error", "ollama.smoke.missing", { model });
      return {
        status: "failed",
        error: { code: "ollama_not_found", message: "ollama CLI not found on this Bee" },
      };
    }

    await this.emit(job, "info", "ollama.smoke.start", { model });
    const result = await this.runStreamingProcess(job, ollamaPath, ["run", model, prompt], signal, {
      stdout: "ollama.smoke.stdout",
      stderr: "ollama.smoke.stderr",
    });
    if (result.status !== "succeeded") return result;
    await this.emit(job, "info", "ollama.smoke.complete", { model });
    return {
      status: "succeeded",
      output: {
        backend: "ollama",
        model,
        endpointUrl: "http://127.0.0.1:11434",
        prompt,
        ...(result.output ?? {}),
      },
    };
  }

  private async runBeeUpdate(job: Job, signal?: AbortSignal): Promise<JobOutcome> {
    const cwd = typeof job.payload.installDir === "string" ? job.payload.installDir : process.cwd();
    const ref =
      typeof job.payload.ref === "string" && job.payload.ref.trim() ? job.payload.ref : "main";
    const remoteRef = `origin/${ref}`;
    await this.emit(job, "info", "bee_update.start", { cwd, ref });

    const fetch = await this.runUpdateCommand(
      job,
      "git",
      ["fetch", "--prune", "origin", ref],
      cwd,
      signal,
    );
    if (!fetch.ok) return fetch.outcome;

    const reset = await this.runUpdateCommand(
      job,
      "git",
      ["reset", "--hard", remoteRef],
      cwd,
      signal,
    );
    if (!reset.ok) return reset.outcome;

    const install = await this.runUpdateCommand(
      job,
      "pnpm",
      ["install", "--frozen-lockfile", "--silent"],
      cwd,
      signal,
    );
    if (!install.ok) return install.outcome;

    await this.emit(job, "info", "bee_update.restart_scheduled", {
      service: process.platform === "darwin" ? "com.hiveplane.bee" : "hiveplane-bee.service",
    });

    return {
      status: "succeeded",
      output: {
        cwd,
        ref,
        fetch: fetch.summary,
        reset: reset.summary,
        install: install.summary,
        restartScheduled: true,
      },
    };
  }

  private async runInstallRuntime(job: Job, signal?: AbortSignal): Promise<JobOutcome> {
    const parsed = RecipeSchema.safeParse(job.payload.recipe);
    if (!parsed.success) {
      await this.emit(job, "error", "recipe.invalid", {
        issues: parsed.error.issues.map((issue) => issue.message),
      });
      return {
        status: "failed",
        error: {
          code: "invalid_recipe",
          message: "install_runtime requires a valid recipe in payload.recipe",
          issues: parsed.error.issues.map((issue) => issue.message),
        },
      };
    }

    const result = await executeRecipe({
      recipe: parsed.data,
      dryRun: job.payload.dryRun === true,
      spawnImpl: this.spawnImpl,
      ...(signal ? { signal } : {}),
      emit: async (event) => {
        await this.emit(job, event.level, event.type, event.data);
      },
    });

    return result;
  }

  private async runInstallModelBackend(job: Job, signal?: AbortSignal): Promise<JobOutcome> {
    const backend = typeof job.payload.backend === "string" ? job.payload.backend : "ollama";
    if (backend !== "ollama") {
      return {
        status: "failed",
        error: {
          code: "unsupported_model_backend",
          message: `install_model_backend does not support backend '${backend}' yet`,
        },
      };
    }
    if (job.payload.dryRun === true) {
      return {
        status: "succeeded",
        output: {
          backend: "ollama",
          dryRun: true,
          plannedSteps:
            process.platform === "darwin"
              ? ["brew install ollama", "brew services start ollama"]
              : ["manual install required for this platform"],
        },
      };
    }
    if (process.platform !== "darwin") {
      return {
        status: "failed",
        error: {
          code: "unsupported_platform",
          message:
            "Automatic Ollama install is currently supported on macOS Homebrew only. Use install_runtime with an explicit recipe for this platform.",
        },
      };
    }
    const brewPath = this.options.brewPathOverride ?? findBrewExecutable();
    if (!brewPath) {
      return {
        status: "failed",
        error: {
          code: "brew_not_found",
          message: "Homebrew is required to install Ollama automatically on macOS.",
        },
      };
    }
    await this.emit(job, "info", "ollama.install.start", { backend });
    const install = await this.runStreamingProcess(job, brewPath, ["install", "ollama"], signal, {
      stdout: "ollama.install.stdout",
      stderr: "ollama.install.stderr",
    });
    if (install.status !== "succeeded") return install;
    const start = await this.startOllamaService(job, signal);
    if (start.status !== "succeeded") return start;
    const status = await getOllamaStatus();
    await this.emit(job, "info", "ollama.install.complete", runtimeStatusToJson(status));
    return {
      status: "succeeded",
      output: {
        backend: "ollama",
        install: install.output ?? {},
        start: start.output ?? {},
        status: runtimeStatusToJson(status),
      },
    };
  }

  private async runConfigureModel(job: Job, signal?: AbortSignal): Promise<JobOutcome> {
    const backend = typeof job.payload.backend === "string" ? job.payload.backend : "ollama";
    const model = typeof job.payload.model === "string" ? job.payload.model.trim() : "";
    if (!model) {
      return {
        status: "failed",
        error: { code: "missing_model", message: "configure_model requires payload.model" },
      };
    }
    if (backend !== "ollama") {
      return {
        status: "failed",
        error: {
          code: "unsupported_model_backend",
          message: `configure_model does not support backend '${backend}' yet`,
        },
      };
    }

    return await this.pullOllamaModel(job, signal, model);
  }

  private async pullOllamaModel(
    job: Job,
    signal?: AbortSignal,
    explicitModel?: string,
  ): Promise<JobOutcome> {
    const model =
      explicitModel ?? (typeof job.payload.model === "string" ? job.payload.model.trim() : "");
    if (!model) {
      return {
        status: "failed",
        error: { code: "missing_model", message: `${job.type} requires payload.model` },
      };
    }
    const ollamaPath = this.options.ollamaPathOverride ?? findOllamaExecutable();
    if (!ollamaPath) {
      await this.emit(job, "error", "ollama.pull.missing", { model });
      return {
        status: "failed",
        error: { code: "ollama_not_found", message: "ollama CLI not found on this Bee" },
      };
    }

    await this.emit(job, "info", "ollama.pull.start", { model });
    const result = await this.runStreamingProcess(job, ollamaPath, ["pull", model], signal, {
      stdout: "ollama.pull.stdout",
      stderr: "ollama.pull.stderr",
    });
    if (result.status !== "succeeded") return result;
    await this.emit(job, "info", "ollama.pull.complete", { model });
    return {
      status: "succeeded",
      output: {
        backend: "ollama",
        model,
        endpointUrl: "http://127.0.0.1:11434",
        ...(result.output ?? {}),
      },
    };
  }

  private async startOllamaService(job: Job, signal?: AbortSignal): Promise<JobOutcome> {
    if (process.platform === "darwin") {
      const brewPath = this.options.brewPathOverride ?? findBrewExecutable();
      if (!brewPath) {
        return {
          status: "failed",
          error: {
            code: "brew_not_found",
            message: "Homebrew is required to start Ollama automatically on macOS.",
          },
        };
      }
      await this.emit(job, "info", "ollama.service.start", { command: brewPath });
      return await this.runStreamingProcess(
        job,
        brewPath,
        ["services", "start", "ollama"],
        signal,
        {
          stdout: "ollama.service.stdout",
          stderr: "ollama.service.stderr",
        },
      );
    }

    await this.emit(job, "warn", "ollama.service.unsupported", { platform: process.platform });
    return {
      status: "failed",
      error: {
        code: "unsupported_platform",
        message:
          "Automatic Ollama start is currently supported on macOS Homebrew only. Start Ollama manually or use install_runtime with an explicit recipe.",
      },
    };
  }

  private async runAgentTask(job: Job, signal?: AbortSignal): Promise<JobOutcome> {
    const taskId = typeof job.payload.taskId === "string" ? job.payload.taskId : job.id;
    const title = typeof job.payload.title === "string" ? job.payload.title : "Hive task";
    const instructions =
      typeof job.payload.instructions === "string" ? job.payload.instructions : "";
    const requestedBy =
      typeof job.payload.requestedBy === "string" ? job.payload.requestedBy : "hive";
    const requirements = readTaskRequirements(job.payload.requirements);
    const runtime =
      typeof job.payload.runtime === "string" ? job.payload.runtime : requirements.runtimes[0];

    await this.emit(job, "info", "agent_task.accepted", { taskId, title });

    if (runtime === "openclaw") {
      return await this.runOpenClawAgentTask(
        job,
        {
          taskId,
          title,
          instructions,
          requestedBy,
          requirements,
        },
        signal,
      );
    }

    await this.emit(job, "info", "agent_task.scaffold", {
      message: "Bee accepted a Hive sub-agent task. Runtime-specific execution will be wired next.",
    });

    return {
      status: "succeeded",
      output: {
        taskId,
        title,
        instructions,
        requestedBy,
        requirements,
        runtime: "scaffold",
        message: "Hive sub-agent task accepted by Bee.",
      },
    };
  }

  private async runOpenClawAgentTask(
    job: Job,
    task: {
      taskId: string;
      title: string;
      instructions: string;
      requestedBy: string;
      requirements: TaskRequirements;
    },
    signal?: AbortSignal,
  ): Promise<JobOutcome> {
    const openclawPath =
      this.options.openclawPathOverride ??
      findExecutable(["/opt/homebrew/bin/openclaw", "/usr/local/bin/openclaw"]);
    if (!openclawPath) {
      await this.emit(job, "error", "agent_task.openclaw.missing", {
        message: "openclaw CLI not found on this Bee",
      });
      return {
        status: "failed",
        error: {
          code: "openclaw_not_found",
          message: "openclaw CLI not found on this Bee",
        },
      };
    }

    const timeoutSeconds = typeof job.timeoutSeconds === "number" ? job.timeoutSeconds : 600;
    const prompt = buildOpenClawTaskPrompt(task);
    const sessionKey = `hiveplane-task-${task.taskId}`;
    const workingDirectory = process.cwd();
    const args = [
      "agent",
      "--session-key",
      sessionKey,
      "--message",
      prompt,
      "--json",
      "--timeout",
      String(timeoutSeconds),
    ];

    await this.emit(job, "info", "agent_task.openclaw.start", {
      taskId: task.taskId,
      sessionKey,
      workingDirectory,
      timeoutSeconds,
      command: openclawPath,
    });
    this.recordAgentSession({
      id: sessionKey,
      runtime: "openclaw",
      label: task.title,
      status: "active",
      taskId: task.taskId,
      workingDirectory,
      updatedAt: new Date().toISOString(),
      metadata: { jobId: job.id },
    });

    const child = this.spawnImpl(openclawPath, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });
    const cleanupCancellation = attachChildCancellation(child, signal);
    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];
    const pendingEventPosts: Promise<void>[] = [];
    const queueEvent = (level: JobEvent["level"], type: string, data: Record<string, JsonValue>) =>
      pendingEventPosts.push(this.emit(job, level, type, data));

    child.stdout?.on("data", (data: Buffer) => {
      const text = sanitizeProcessText(data.toString("utf8"));
      stdoutChunks.push(text);
      queueEvent("debug", "agent_task.openclaw.stdout", { text: truncateText(text, 4_000) });
    });
    child.stderr?.on("data", (data: Buffer) => {
      const text = sanitizeProcessText(data.toString("utf8"));
      stderrChunks.push(text);
      queueEvent("debug", "agent_task.openclaw.stderr", { text: truncateText(text, 4_000) });
    });

    return await new Promise<JobOutcome>((resolve) => {
      child.once("error", async (err) => {
        cleanupCancellation();
        await Promise.allSettled(pendingEventPosts);
        resolve({
          status: "failed",
          error: { code: "openclaw_spawn_error", message: err.message },
        });
      });
      child.once("close", async (exitCode, exitSignal) => {
        cleanupCancellation();
        await Promise.allSettled(pendingEventPosts);
        const stdout = stdoutChunks.join("");
        const stderr = stderrChunks.join("");
        const parsed = parseJsonObject(stdout);
        const compactResult = parsed ? compactOpenClawResult(parsed) : undefined;
        const summary: Record<string, JsonValue> = {
          taskId: task.taskId,
          title: task.title,
          runtime: "openclaw",
          sessionId: sessionKey,
          sessionKey,
          workingDirectory,
          exitCode: exitCode ?? -1,
          signal: exitSignal ?? null,
          stdout: truncateText(stdout, 8_000),
          stderr: truncateText(stderr, 8_000),
          ...(compactResult ? { result: compactResult } : {}),
        };

        if (exitCode === 0) {
          this.recordAgentSession({
            id: sessionKey,
            runtime: "openclaw",
            label: task.title,
            status: "recent",
            taskId: task.taskId,
            workingDirectory,
            updatedAt: new Date().toISOString(),
            metadata: { jobId: job.id, exitCode: exitCode ?? -1 },
          });
          resolve({ status: "succeeded", output: summary });
          return;
        }
        if (exitSignal && signal?.aborted) {
          resolve(cancelledOutcome(job, exitSignal));
          return;
        }
        resolve({
          status: "failed",
          error: {
            code: exitSignal ? "openclaw_agent_signalled" : "openclaw_agent_failed",
            message: `openclaw agent exited ${exitCode}${exitSignal ? ` (signal ${exitSignal})` : ""}`,
            ...summary,
          },
        });
        this.recordAgentSession({
          id: sessionKey,
          runtime: "openclaw",
          label: task.title,
          status: "recent",
          taskId: task.taskId,
          workingDirectory,
          updatedAt: new Date().toISOString(),
          metadata: {
            jobId: job.id,
            exitCode: exitCode ?? -1,
            ...(exitSignal ? { signal: exitSignal } : {}),
          },
        });
      });
    });
  }

  private recordAgentSession(session: {
    id: string;
    runtime: string;
    label?: string;
    status: "active" | "recent" | "stale";
    taskId?: string;
    workingDirectory?: string;
    updatedAt: string;
    metadata: Record<string, JsonValue>;
  }): void {
    try {
      upsertAgentSessionRegistry(session, this.options.configDir);
    } catch {
      // Session registry is advisory; job execution should not fail if it cannot be written.
    }
  }

  private async runUpdateCommand(
    job: Job,
    command: string,
    args: string[],
    cwd: string,
    signal?: AbortSignal,
  ): Promise<
    | { ok: true; summary: Record<string, JsonValue> }
    | { ok: false; outcome: Extract<JobOutcome, { status: "failed" | "cancelled" }> }
  > {
    await this.emit(job, "info", "bee_update.command.start", { command, args });
    const child = this.spawnImpl(command, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });
    const cleanupCancellation = attachChildCancellation(child, signal);
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
        cleanupCancellation();
        await Promise.allSettled(pendingEventPosts);
        resolve({
          ok: false,
          outcome: {
            status: "failed",
            error: { code: "update_spawn_error", command, message: err.message },
          },
        });
      });
      child.once("close", async (exitCode, exitSignal) => {
        cleanupCancellation();
        await Promise.allSettled(pendingEventPosts);
        const summary: Record<string, JsonValue> = {
          command,
          args,
          exitCode: exitCode ?? -1,
          signal: exitSignal ?? null,
          stdout: stdoutChunks.join(""),
          stderr: stderrChunks.join(""),
        };
        if (exitCode === 0) {
          resolve({ ok: true, summary });
          return;
        }
        if (exitSignal && signal?.aborted) {
          resolve({
            ok: false,
            outcome: {
              status: "cancelled",
              error: {
                code: "job_cancelled",
                message: `job cancelled while running ${command}`,
                ...summary,
              },
            },
          });
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
      ...(outcome.status === "cancelled" ? { error: outcome.error } : {}),
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

function attachChildCancellation(child: ChildProcess, signal?: AbortSignal): () => void {
  if (!signal) return () => undefined;
  let killTimer: NodeJS.Timeout | undefined;
  const abort = () => {
    if (!child.killed) child.kill("SIGTERM");
    killTimer = setTimeout(() => {
      if (!child.killed) child.kill("SIGKILL");
    }, 5_000);
    killTimer.unref();
  };
  if (signal.aborted) abort();
  signal.addEventListener("abort", abort, { once: true });
  return () => {
    signal.removeEventListener("abort", abort);
    if (killTimer) clearTimeout(killTimer);
  };
}

function cancelledOutcome(
  job: Job,
  signal = "SIGTERM",
): Extract<JobOutcome, { status: "cancelled" }> {
  return {
    status: "cancelled",
    error: {
      code: "job_cancelled",
      message: `job ${job.id} cancelled${signal ? ` (${signal})` : ""}`,
    },
  };
}

type TaskRequirements = {
  runtimes: string[];
  tools: string[];
  modelBackends: string[];
  models: string[];
};

function readTaskRequirements(value: JsonValue | undefined): TaskRequirements {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { runtimes: [], tools: [], modelBackends: [], models: [] };
  }
  return {
    runtimes: readStringArray(value.runtimes),
    tools: readStringArray(value.tools),
    modelBackends: readStringArray(value.modelBackends),
    models: readStringArray(value.models),
  };
}

function readStringArray(value: JsonValue | undefined): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function buildOpenClawTaskPrompt(task: {
  taskId: string;
  title: string;
  instructions: string;
  requestedBy: string;
  requirements: TaskRequirements;
}): string {
  return [
    "You are running as a HivePlane Bee sub-agent task.",
    "Return a concise result for HivePlane. Do not deliver messages externally unless the task instructions explicitly require it and local policy allows it.",
    "",
    `Task ID: ${task.taskId}`,
    `Title: ${task.title}`,
    `Requested by: ${task.requestedBy}`,
    `Requirements: ${JSON.stringify(task.requirements)}`,
    "",
    "Instructions:",
    task.instructions,
  ].join("\n");
}

function buildOpenClawSubAgentSmokePrompt(subAgent: {
  id: string;
  name: string;
  runtime: string;
  systemId?: string | undefined;
  modelProvider?: string | undefined;
  model?: string | undefined;
  tools: string[];
  skills: string[];
  workingDirectories: string[];
}): string {
  return [
    "You are running a HivePlane OpenClaw sub-agent smoke test.",
    "Reply with a short JSON object that includes ok=true and the subAgentId. Do not take external actions.",
    "",
    `Sub-agent ID: ${subAgent.id}`,
    `Name: ${subAgent.name}`,
    `Runtime: ${subAgent.runtime}`,
    `System: ${subAgent.systemId ?? "unspecified"}`,
    `Model provider: ${subAgent.modelProvider ?? "runtime default"}`,
    `Model: ${subAgent.model ?? "runtime default"}`,
    `Tools: ${JSON.stringify(subAgent.tools)}`,
    `Skills: ${JSON.stringify(subAgent.skills)}`,
    `Working directories: ${JSON.stringify(subAgent.workingDirectories)}`,
  ].join("\n");
}

function subAgentCapabilityToJson(subAgent: {
  id: string;
  name: string;
  runtime: string;
  status: string;
  systemId?: string | undefined;
  modelProvider?: string | undefined;
  model?: string | undefined;
  tools: string[];
  skills: string[];
  workingDirectories: string[];
  updatedAt: string;
  metadata: Record<string, JsonValue>;
}): Record<string, JsonValue> {
  return {
    id: subAgent.id,
    name: subAgent.name,
    runtime: subAgent.runtime,
    status: subAgent.status,
    ...(subAgent.systemId ? { systemId: subAgent.systemId } : {}),
    ...(subAgent.modelProvider ? { modelProvider: subAgent.modelProvider } : {}),
    ...(subAgent.model ? { model: subAgent.model } : {}),
    tools: subAgent.tools,
    skills: subAgent.skills,
    workingDirectories: subAgent.workingDirectories,
    updatedAt: subAgent.updatedAt,
    metadata: subAgent.metadata,
  };
}

function parseJsonObject(stdout: string): Record<string, JsonValue> | undefined {
  const trimmed = stdout.trim();
  if (!trimmed) return undefined;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, JsonValue>;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function compactOpenClawResult(parsed: Record<string, JsonValue>): Record<string, JsonValue> {
  const result = readObject(parsed.result);
  const meta = readObject(result?.meta);
  const agentMeta = readObject(meta?.agentMeta);
  const compact: Record<string, JsonValue> = {};
  const finalText = readOpenClawFinalText(parsed);
  if (typeof parsed.runId === "string") compact.runId = parsed.runId;
  if (typeof parsed.status === "string") compact.status = parsed.status;
  if (typeof parsed.summary === "string") compact.summary = parsed.summary;
  if (finalText) compact.finalText = finalText;
  if (typeof meta?.durationMs === "number") compact.durationMs = meta.durationMs;
  if (agentMeta) {
    const agent: Record<string, JsonValue> = {};
    if (typeof agentMeta.sessionId === "string") agent.sessionId = agentMeta.sessionId;
    if (typeof agentMeta.provider === "string") agent.provider = agentMeta.provider;
    if (typeof agentMeta.model === "string") agent.model = agentMeta.model;
    if (typeof agentMeta.agentHarnessId === "string") agent.harness = agentMeta.agentHarnessId;
    const usage = readObject(agentMeta.usage);
    if (usage) agent.usage = usage;
    compact.agent = agent;
  }
  return compact;
}

function readOpenClawFinalText(parsed: Record<string, JsonValue>): string | undefined {
  if (typeof parsed.finalAssistantVisibleText === "string") return parsed.finalAssistantVisibleText;
  const result = readObject(parsed.result);
  const payloads = result?.payloads;
  if (!Array.isArray(payloads)) return undefined;
  for (const payload of payloads) {
    const item = readObject(payload);
    if (typeof item?.text === "string" && item.text.trim()) return item.text;
  }
  return undefined;
}

function readObject(value: JsonValue | undefined): Record<string, JsonValue> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, JsonValue>)
    : undefined;
}

function truncateText(value: string, maxLength: number): string {
  const sanitized = sanitizeProcessText(value);
  if (sanitized.length <= maxLength) return sanitized;
  return `${sanitized.slice(0, maxLength)}\n...[truncated ${sanitized.length - maxLength} chars]`;
}

function sanitizeProcessText(value: string): string {
  return value
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
}

function findExecutable(paths: string[]): string | undefined {
  return paths.find((candidate) => {
    try {
      return existsSync(candidate) && statSync(candidate).isFile();
    } catch {
      return false;
    }
  });
}

function findBrewExecutable(): string | undefined {
  return findExecutable(["/opt/homebrew/bin/brew", "/usr/local/bin/brew"]);
}
