import { execFile, type ExecFileException } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { homedir, platform } from "node:os";
import { promisify } from "node:util";
import type { BeeHealthCheck } from "@hiveplane/protocol";

const execFileAsync = promisify(execFile);

type CommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

export async function collectBeeHealthChecks(now = new Date()): Promise<BeeHealthCheck[]> {
  const checkedAt = now.toISOString();
  const checks = await Promise.all([
    beeProcessCheck(checkedAt),
    diskFreeCheck(checkedAt),
    launchdCheck("hiveplane-bee", "com.hiveplane.bee", checkedAt),
    launchdCheck("openclaw-gateway", "ai.openclaw.gateway", checkedAt),
    launchdCheck("hermes-gateway", "ai.hermes.gateway", checkedAt),
    launchdCheck("ollama-service", "homebrew.mxcl.ollama", checkedAt),
    ollamaModelsCheck(checkedAt),
  ]);

  return checks.filter((check): check is BeeHealthCheck => Boolean(check));
}

export function statusFromHealthChecks(checks: BeeHealthCheck[]): "online" | "degraded" {
  return checks.some((check) => check.status === "failing") ? "degraded" : "online";
}

function beeProcessCheck(checkedAt: string): BeeHealthCheck {
  return {
    name: "bee-process",
    status: "passing",
    checkedAt,
    message: `pid ${process.pid}`,
  };
}

async function diskFreeCheck(checkedAt: string): Promise<BeeHealthCheck> {
  try {
    const result = await runCommand("/bin/df", ["-k", homedir()], 5_000);
    const lines = result.stdout.trim().split("\n");
    const fields = lines.at(-1)?.trim().split(/\s+/) ?? [];
    const availableKb = Number(fields[3]);
    if (!Number.isFinite(availableKb)) {
      return { name: "disk-home", status: "unknown", checkedAt, message: "could not parse df" };
    }
    const freeGb = Math.round((availableKb / 1024 / 1024) * 10) / 10;
    return {
      name: "disk-home",
      status: freeGb < 5 ? "failing" : "passing",
      checkedAt,
      message: `${freeGb} GB free`,
    };
  } catch (error) {
    return failure("disk-home", checkedAt, error);
  }
}

async function launchdCheck(
  name: string,
  label: string,
  checkedAt: string,
): Promise<BeeHealthCheck | undefined> {
  if (platform() !== "darwin") return undefined;

  try {
    const result = await runCommand("/bin/launchctl", ["list"], 5_000);
    const line = result.stdout
      .split("\n")
      .find((candidate) => candidate.trim().endsWith(`\t${label}`));
    if (!line) {
      return { name, status: "unknown", checkedAt, message: `${label} not installed` };
    }

    const [pid, lastExit] = line.trim().split(/\s+/);
    const running = pid !== "-";
    return {
      name,
      status: running ? "passing" : "failing",
      checkedAt,
      message: running ? `${label} running pid ${pid}` : `${label} stopped; last exit ${lastExit}`,
    };
  } catch (error) {
    return failure(name, checkedAt, error);
  }
}

async function ollamaModelsCheck(checkedAt: string): Promise<BeeHealthCheck> {
  const ollamaPath = findExecutable(["/opt/homebrew/bin/ollama", "/usr/local/bin/ollama"]);
  if (!ollamaPath) {
    return { name: "ollama-models", status: "unknown", checkedAt, message: "ollama not installed" };
  }

  try {
    const result = await runCommand(ollamaPath, ["list"], 7_500);
    const models = result.stdout
      .split("\n")
      .slice(1)
      .map((line) => line.trim().split(/\s+/)[0])
      .filter(Boolean);
    return {
      name: "ollama-models",
      status: "passing",
      checkedAt,
      message: models.length > 0 ? models.slice(0, 5).join(", ") : "no local models pulled",
    };
  } catch (error) {
    return failure("ollama-models", checkedAt, error);
  }
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

async function runCommand(
  command: string,
  args: string[],
  timeoutMs: number,
): Promise<CommandResult> {
  try {
    const result = await execFileAsync(command, args, { timeout: timeoutMs, windowsHide: true });
    return { exitCode: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const execError = error as ExecFileException & { stdout?: string; stderr?: string };
    throw new Error(
      `${command} ${args.join(" ")} failed: ${
        error instanceof Error ? error.message : String(error)
      }${execError.stderr ? `; ${execError.stderr}` : ""}`,
    );
  }
}

function failure(name: string, checkedAt: string, error: unknown): BeeHealthCheck {
  return {
    name,
    status: "failing",
    checkedAt,
    message: (error instanceof Error ? error.message : String(error)).slice(0, 500),
  };
}
