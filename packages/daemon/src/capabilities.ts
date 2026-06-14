import { execFile, type ExecFileException } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { promisify } from "node:util";
import type { BeeCapabilities, BeeHardware, JsonValue } from "@hiveplane/protocol";
import type { BeeHardwareSnapshot } from "./index.js";

const execFileAsync = promisify(execFile);

export type RuntimeStatus = {
  installed: boolean;
  running?: boolean;
  version?: string;
  models?: string[];
  endpointUrl?: string;
  message?: string;
};

export async function collectBeeCapabilities(
  hardware: BeeHardwareSnapshot,
): Promise<BeeCapabilities> {
  const capabilities: BeeCapabilities = {
    runtimes: [],
    modelBackends: [],
    models: [],
    tools: [],
    networking: [],
    hardware: toCapabilitiesHardware(hardware),
  };

  const [openclaw, ollama, mlx] = await Promise.all([
    getOpenClawStatus(),
    getOllamaStatus(),
    getMlxStatus(),
  ]);

  if (openclaw.installed || openclaw.running) {
    capabilities.runtimes.push("openclaw");
    capabilities.tools.push("openclaw");
  }

  if (ollama.installed || ollama.running) {
    capabilities.modelBackends.push("ollama");
    capabilities.models.push(...(ollama.models ?? []));
  }

  if (mlx.installed) {
    capabilities.modelBackends.push("mlx");
  }

  if (
    findExecutable([
      "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
      "/opt/homebrew/bin/tailscale",
      "/usr/local/bin/tailscale",
    ])
  ) {
    capabilities.networking.push("tailscale");
  }

  return capabilities;
}

export async function getOpenClawStatus(): Promise<RuntimeStatus> {
  const openclawPath = findExecutable(["/opt/homebrew/bin/openclaw", "/usr/local/bin/openclaw"]);
  const launchd = await launchdServiceStatus("ai.openclaw.gateway");
  const installed = Boolean(openclawPath) || launchd.installed;
  const status: RuntimeStatus = {
    installed,
    ...(launchd.installed ? { running: launchd.running } : {}),
  };

  if (!installed) return { installed: false, message: "openclaw not installed" };

  if (openclawPath) {
    try {
      const version = await runCommand(openclawPath, ["--version"], 5_000);
      const firstLine = version.stdout.trim().split("\n")[0];
      if (firstLine) status.version = firstLine;
    } catch (error) {
      status.message = shortError(error);
    }
  }

  if (launchd.message) status.message = launchd.message;
  return status;
}

export async function getOllamaStatus(): Promise<RuntimeStatus> {
  const ollamaPath = findExecutable(["/opt/homebrew/bin/ollama", "/usr/local/bin/ollama"]);
  const launchd = await launchdServiceStatus("homebrew.mxcl.ollama");
  if (!ollamaPath && !launchd.installed) {
    return { installed: false, message: "ollama not installed" };
  }

  const status: RuntimeStatus = {
    installed: Boolean(ollamaPath) || launchd.installed,
    endpointUrl: "http://127.0.0.1:11434",
    ...(launchd.installed ? { running: launchd.running } : {}),
  };

  if (!ollamaPath) {
    status.message = launchd.message ?? "ollama service found but CLI was not found";
    return status;
  }

  try {
    const version = await runCommand(ollamaPath, ["--version"], 5_000);
    const firstLine = version.stdout.trim().split("\n")[0];
    if (firstLine) status.version = firstLine;
  } catch (error) {
    status.message = shortError(error);
  }

  const list = await listOllamaModels();
  status.models = list.models;
  if (list.message) status.message = list.message;
  return status;
}

export async function getMlxStatus(): Promise<RuntimeStatus> {
  const pythonPath = findExecutable([
    "/opt/homebrew/bin/python3",
    "/usr/local/bin/python3",
    "/usr/bin/python3",
  ]);
  if (!pythonPath) return { installed: false, message: "python3 not found for MLX probe" };

  try {
    await runCommand(pythonPath, ["-c", "import mlx_lm"], 5_000);
    return { installed: true, message: "mlx_lm import succeeded" };
  } catch (error) {
    return { installed: false, message: shortError(error) };
  }
}

export async function listOllamaModels(): Promise<{ models: string[]; message?: string }> {
  const ollamaPath = findExecutable(["/opt/homebrew/bin/ollama", "/usr/local/bin/ollama"]);
  if (!ollamaPath) return { models: [], message: "ollama not installed" };

  try {
    const result = await runCommand(ollamaPath, ["list"], 7_500);
    const models = result.stdout
      .split("\n")
      .slice(1)
      .map((line) => line.trim().split(/\s+/)[0])
      .filter((model): model is string => Boolean(model));
    return { models };
  } catch (error) {
    return { models: [], message: shortError(error) };
  }
}

export function runtimeStatusToJson(status: RuntimeStatus): Record<string, JsonValue> {
  return {
    installed: status.installed,
    ...(status.running !== undefined ? { running: status.running } : {}),
    ...(status.version ? { version: status.version } : {}),
    ...(status.models ? { models: status.models } : {}),
    ...(status.endpointUrl ? { endpointUrl: status.endpointUrl } : {}),
    ...(status.message ? { message: status.message } : {}),
  };
}

export function findOllamaExecutable(): string | undefined {
  return findExecutable(["/opt/homebrew/bin/ollama", "/usr/local/bin/ollama"]);
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

function toCapabilitiesHardware(hardware: BeeHardwareSnapshot): BeeHardware {
  if (hardware.platform === "unsupported") {
    return {
      platform: "linux-x64",
      hostname: hardware.hostname,
      cpuCores: hardware.cpuCores,
      memoryGb: hardware.memoryGb,
    };
  }
  return {
    platform: hardware.platform,
    hostname: hardware.hostname,
    cpuCores: hardware.cpuCores,
    memoryGb: hardware.memoryGb,
  };
}

async function launchdServiceStatus(
  label: string,
): Promise<{ installed: boolean; running?: boolean; message?: string }> {
  if (process.platform !== "darwin") return { installed: false };
  try {
    const result = await runCommand("/bin/launchctl", ["list"], 5_000);
    const line = result.stdout
      .split("\n")
      .find((candidate) => candidate.trim().endsWith(`\t${label}`));
    if (!line) return { installed: false, message: `${label} not installed` };
    const [pid, lastExit] = line.trim().split(/\s+/);
    const running = pid !== "-";
    return {
      installed: true,
      running,
      message: running ? `${label} running pid ${pid}` : `${label} stopped; last exit ${lastExit}`,
    };
  } catch (error) {
    return { installed: false, message: shortError(error) };
  }
}

async function runCommand(
  command: string,
  args: string[],
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string }> {
  try {
    return await execFileAsync(command, args, { timeout: timeoutMs, windowsHide: true });
  } catch (error) {
    const execError = error as ExecFileException & { stdout?: string; stderr?: string };
    throw new Error(
      `${command} ${args.join(" ")} failed: ${
        error instanceof Error ? error.message : String(error)
      }${execError.stderr ? `; ${execError.stderr}` : ""}`,
    );
  }
}

function shortError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 500);
}
