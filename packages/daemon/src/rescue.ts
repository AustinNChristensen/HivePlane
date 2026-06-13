import { spawn } from "node:child_process";
import { sign as edSign, randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  JobCompleteRequestSchema,
  JobEventBatchSchema,
  JobSchema,
  RescueHeartbeatSchema,
  type Job,
  type JobEvent,
  type JsonValue,
} from "@hiveplane/protocol";
import { readHivePlaneConfig } from "./config.js";
import { createDaemonState } from "./index.js";
import { loadOrCreateBeeIdentity, type BeeIdentity } from "./identity.js";
import { isSessionExpired, readHiveSession, type HiveSession } from "./session.js";

const VERSION = "0.0.7";
const RESCUE_ACTIONS = ["restart_bee", "update_bee", "collect_bee_logs"] as const;

type RescueCliOptions = {
  hiveUrl: string;
  configDir?: string;
  intervalSeconds: number;
  once: boolean;
};

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const identity = await loadOrCreateBeeIdentity(
    options.configDir ? { configDir: options.configDir } : {},
  );
  const session = readHiveSession(options.configDir);
  if (!session || session.hiveUrl !== options.hiveUrl || isSessionExpired(session)) {
    throw new Error("Rescue requires an active Bee session. Run `bee login <url>` first.");
  }
  const activeSession = session;

  const state = createDaemonState({
    beeId: activeSession.beeId,
    hiveUrl: options.hiveUrl,
    heartbeatIntervalSeconds: options.intervalSeconds,
  });
  const executor = new RescueExecutor({
    hiveUrl: options.hiveUrl,
    session: activeSession,
    identity,
    ...(options.configDir ? { configDir: options.configDir } : {}),
  });

  console.log(`[rescue] bee=${activeSession.beeId}`);
  console.log(`[rescue] hive=${options.hiveUrl}`);
  console.log(`[rescue] actions=${RESCUE_ACTIONS.join(",")}`);

  async function sendHeartbeat(): Promise<void> {
    const heartbeat = RescueHeartbeatSchema.parse({
      type: "rescue.heartbeat",
      beeId: activeSession.beeId,
      timestamp: new Date().toISOString(),
      rescueVersion: VERSION,
      status: "online",
      capabilities: {
        actions: [...RESCUE_ACTIONS],
        hardware: state.capabilities.hardware,
      },
    });
    const rawBody = Buffer.from(JSON.stringify(heartbeat));
    const response = await signedFetch({
      url: new URL("/api/rescue/heartbeat", options.hiveUrl),
      rawBody,
      session: activeSession,
      identity,
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`Hive rescue heartbeat failed: ${response.status} ${text}`);
    }
    const body = (await response.json()) as { accepted?: boolean; jobs?: unknown[] };
    if (body.accepted !== true) throw new Error("Hive rejected rescue heartbeat");
    const jobs = (body.jobs ?? []).map((job) => JobSchema.parse(job));
    console.log(`[rescue] heartbeat ok jobs=${jobs.length}`);
    for (const job of jobs) {
      await executor.execute(job);
    }
  }

  if (options.once) {
    await sendHeartbeat();
    console.log("[rescue] heartbeat sent");
    return;
  }

  let stopped = false;
  process.once("SIGINT", () => {
    stopped = true;
  });
  process.once("SIGTERM", () => {
    stopped = true;
  });

  while (!stopped) {
    try {
      await sendHeartbeat();
      await delay(options.intervalSeconds * 1000);
    } catch (error) {
      console.error(`[rescue] ${error instanceof Error ? error.message : String(error)}`);
      await delay(Math.min(options.intervalSeconds * 1000, 30_000)).catch(() => undefined);
    }
  }
}

type RescueExecutorOptions = {
  hiveUrl: string;
  session: HiveSession;
  identity: BeeIdentity;
  configDir?: string;
};

class RescueExecutor {
  private sequence = 0;

  constructor(private readonly options: RescueExecutorOptions) {}

  async execute(job: Job): Promise<void> {
    try {
      if (job.type === "restart_bee") {
        await this.emit(job, "info", "rescue.restart_bee.start", {});
        await restartBeeService();
        await this.complete(job, {
          status: "succeeded",
          output: { restarted: true, service: beeServiceName() },
        });
        return;
      }
      if (job.type === "update_bee") {
        const cwd = process.cwd();
        await this.emit(job, "info", "rescue.update_bee.start", { cwd });
        const git = await runFixedCommand("git", ["pull", "--ff-only"], cwd, (text) =>
          this.emit(job, "debug", "rescue.update_bee.stdout", { command: "git", text }),
        );
        if (!git.ok) {
          await this.complete(job, { status: "failed", error: git.error });
          return;
        }
        const install = await runFixedCommand(
          "pnpm",
          ["install", "--frozen-lockfile", "--silent"],
          cwd,
          (text) => this.emit(job, "debug", "rescue.update_bee.stdout", { command: "pnpm", text }),
        );
        if (!install.ok) {
          await this.complete(job, { status: "failed", error: install.error });
          return;
        }
        await restartBeeService();
        await this.complete(job, {
          status: "succeeded",
          output: { cwd, git: git.summary, install: install.summary, restartScheduled: true },
        });
        return;
      }
      if (job.type === "collect_bee_logs") {
        const logs = collectBeeLogs(this.options.configDir);
        await this.complete(job, { status: "succeeded", output: logs });
        return;
      }
      await this.complete(job, {
        status: "failed",
        error: { code: "unsupported_rescue_job", message: `${job.type} is not a rescue action` },
      });
    } catch (error) {
      await this.complete(job, {
        status: "failed",
        error: {
          code: "rescue_executor_threw",
          message: error instanceof Error ? error.message : String(error),
        },
      });
    }
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
    await signedFetch({
      url: new URL(`/api/jobs/${job.id}/events`, this.options.hiveUrl),
      rawBody: Buffer.from(JSON.stringify(batch)),
      session: this.options.session,
      identity: this.options.identity,
    });
  }

  private async complete(
    job: Job,
    outcome:
      | { status: "succeeded"; output?: Record<string, JsonValue> }
      | { status: "failed"; error: Record<string, JsonValue> },
  ): Promise<void> {
    const payload = JobCompleteRequestSchema.parse({
      type: "job.complete",
      jobId: job.id,
      beeId: this.options.session.beeId,
      status: outcome.status,
      ...(outcome.status === "succeeded" && outcome.output ? { output: outcome.output } : {}),
      ...(outcome.status === "failed" ? { error: outcome.error } : {}),
      completedAt: new Date().toISOString(),
    });
    await signedFetch({
      url: new URL(`/api/jobs/${job.id}/complete`, this.options.hiveUrl),
      rawBody: Buffer.from(JSON.stringify(payload)),
      session: this.options.session,
      identity: this.options.identity,
    });
  }
}

async function signedFetch(options: {
  url: URL;
  rawBody: Buffer;
  session: HiveSession;
  identity: BeeIdentity;
}): Promise<Response> {
  const privateKeyPem = readFileSync(options.identity.privateKeyPath, "utf8");
  const signature = edSign(null, options.rawBody, privateKeyPem).toString("base64url");
  return await fetch(options.url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${options.session.sessionToken}`,
      "x-bee-signature": signature,
    },
    body: new Uint8Array(options.rawBody),
    signal: AbortSignal.timeout(15_000),
  });
}

function restartBeeService(): Promise<void> {
  const args =
    process.platform === "darwin"
      ? ["launchctl", ["kickstart", "-k", `gui/${userInfo().uid}/com.hiveplane.bee`]]
      : process.platform === "linux"
        ? ["systemctl", ["--user", "restart", "hiveplane-bee.service"]]
        : [];
  if (args.length === 0) throw new Error(`unsupported platform: ${process.platform}`);
  return runProcess(args[0] as string, args[1] as string[]).then(() => undefined);
}

function beeServiceName(): string {
  if (process.platform === "darwin") return "com.hiveplane.bee";
  if (process.platform === "linux") return "hiveplane-bee.service";
  return "unsupported";
}

async function runFixedCommand(
  command: string,
  args: string[],
  cwd: string,
  onStdout: (text: string) => Promise<void>,
): Promise<
  | { ok: true; summary: Record<string, JsonValue> }
  | { ok: false; error: Record<string, JsonValue> }
> {
  const result = await runProcess(command, args, cwd, onStdout);
  const summary: Record<string, JsonValue> = { command, args, ...result };
  if (result.exitCode === 0) return { ok: true, summary };
  return {
    ok: false,
    error: {
      code: "rescue_command_failed",
      message: `${command} exited ${result.exitCode}`,
      ...summary,
    },
  };
}

function runProcess(
  command: string,
  args: string[],
  cwd?: string,
  onStdout?: (text: string) => Promise<void>,
): Promise<{ exitCode: number; signal: string | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      ...(cwd ? { cwd } : {}),
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });
    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];
    const pending: Promise<void>[] = [];
    child.stdout?.on("data", (data: Buffer) => {
      const text = data.toString("utf8");
      stdoutChunks.push(text);
      if (onStdout) pending.push(onStdout(text).catch(() => undefined));
    });
    child.stderr?.on("data", (data: Buffer) => stderrChunks.push(data.toString("utf8")));
    child.once("error", reject);
    child.once("close", async (exitCode, signal) => {
      await Promise.allSettled(pending);
      resolve({
        exitCode: exitCode ?? -1,
        signal,
        stdout: stdoutChunks.join(""),
        stderr: stderrChunks.join(""),
      });
    });
  });
}

function collectBeeLogs(configDir = join(homedir(), ".hiveplane")): Record<string, JsonValue> {
  const logDir = join(configDir, "logs");
  return {
    stdout: tailFile(join(logDir, "bee.out.log")),
    stderr: tailFile(join(logDir, "bee.err.log")),
  };
}

function tailFile(path: string): string {
  if (!existsSync(path)) return "";
  const text = readFileSync(path, "utf8");
  return text.slice(-20_000);
}

function parseArgs(args: string[]): RescueCliOptions {
  let hiveUrl = process.env.HIVEPLANE_HIVE_URL;
  let configDir = process.env.HIVEPLANE_CONFIG_DIR;
  let intervalSeconds = Number(process.env.HIVEPLANE_RESCUE_INTERVAL_SECONDS ?? 30);
  let once = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--hive-url") hiveUrl = requireValue(args, ++index, "--hive-url");
    else if (arg === "--config-dir") configDir = requireValue(args, ++index, "--config-dir");
    else if (arg === "--interval")
      intervalSeconds = Number(requireValue(args, ++index, "--interval"));
    else if (arg === "--once") once = true;
    else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!hiveUrl) hiveUrl = readHivePlaneConfig(configDir).hiveUrl;
  if (!hiveUrl) throw new Error("No Hive URL configured. Run `bee login <url>` first.");
  if (!Number.isInteger(intervalSeconds) || intervalSeconds <= 0) {
    throw new Error(`Invalid --interval: ${intervalSeconds}`);
  }
  return {
    hiveUrl,
    ...(configDir ? { configDir } : {}),
    intervalSeconds,
    once,
  };
}

function requireValue(args: string[], index: number, flag: string): string {
  const value = args[index];
  if (!value) throw new Error(`${flag} requires a value`);
  return value;
}

function printHelp(): void {
  console.log(
    `HivePlane Rescue Agent v${VERSION}

Usage:
  hiveplane-rescue
  hiveplane-rescue --once

Options:
  --hive-url <url>      Hive URL (defaults to ~/.hiveplane/config.json)
  --config-dir <path>   Config/identity directory, defaults to ~/.hiveplane
  --interval <seconds>  Rescue heartbeat interval, defaults to 30
  --once                Send one rescue heartbeat and exit
`,
  );
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
