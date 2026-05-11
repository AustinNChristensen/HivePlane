// Shared infrastructure used by both `bee.ts` and `hive.ts` entry points.
// v0.0.5 split the single `hive` CLI into two binaries — Bee verbs live on
// the `bee` binary, Hive verbs on the `hive` binary — which means the
// argument-parsing primitives, the install-environment resolver, and the
// "run logs from file" helper want to live in one place rather than be
// duplicated in two thin entries.

import { execFileSync } from "node:child_process";
import { createReadStream, existsSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";

export const VERSION = "0.0.6";

export type ArgvParseResult = {
  configDir?: string;
  positional: string[];
  flags: Map<string, string | true>;
};

export function stripGlobalFlags(args: string[]): { configDir?: string; commandArgs: string[] } {
  const out: string[] = [];
  let configDir: string | undefined;
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i] as string;
    if (a === "--") continue;
    if (a === "--config-dir") {
      configDir = requireValue(args, ++i, "--config-dir");
    } else {
      out.push(a);
    }
  }
  return { ...(configDir ? { configDir } : {}), commandArgs: out };
}

export function parseArgs(args: string[]): ArgvParseResult {
  const positional: string[] = [];
  const flags = new Map<string, string | true>();
  let configDir: string | undefined = process.env.HIVEPLANE_CONFIG_DIR;

  for (let i = 0; i < args.length; i += 1) {
    const a = args[i] as string;
    if (a === "--config-dir") {
      configDir = requireValue(args, ++i, "--config-dir");
    } else if (a === "--name") {
      flags.set("name", requireValue(args, ++i, "--name"));
    } else if (a === "--token") {
      flags.set("token", requireValue(args, ++i, "--token"));
    } else if (a === "--pairing-key") {
      flags.set("pairing-key", requireValue(args, ++i, "--pairing-key"));
    } else if (a === "--host") {
      flags.set("host", requireValue(args, ++i, "--host"));
    } else if (a === "--port") {
      flags.set("port", requireValue(args, ++i, "--port"));
    } else if (a === "-f") {
      flags.set("follow", true);
    } else if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq > -1) {
        flags.set(a.slice(2, eq), a.slice(eq + 1));
      } else {
        flags.set(a.slice(2), true);
      }
    } else {
      positional.push(a);
    }
  }

  return { ...(configDir ? { configDir } : {}), positional, flags };
}

export function stringFlag(parsed: ArgvParseResult, name: string): string | undefined {
  const value = parsed.flags.get(name);
  return typeof value === "string" ? value : undefined;
}

export function boolFlag(parsed: ArgvParseResult, name: string): boolean | undefined {
  const value = parsed.flags.get(name);
  if (value === true) return true;
  if (typeof value === "string") {
    if (value === "true" || value === "1") return true;
    if (value === "false" || value === "0") return false;
  }
  return undefined;
}

export function requireValue(args: string[], index: number, flag: string): string {
  const value = args[index];
  if (!value) {
    console.error(`${flag} requires a value`);
    process.exit(2);
  }
  return value;
}

/**
 * Prompt the user for a single line of input. Always uses stdin/stdout, and
 * always closes the readline interface — re-prompting is the caller's job.
 */
export async function promptLine(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(question);
  } finally {
    rl.close();
  }
}

export type InstallEnvironment = {
  installDir: string;
  pnpmBin: string;
  nodeBinDir: string;
};

export function resolveInstallEnvironment(here: string): InstallEnvironment {
  // here = dirname(fileURLToPath(import.meta.url)) of the caller. From any
  // of our entry files (bee.ts, hive.ts), the repo root is three levels up:
  // packages/cli/src → packages/cli → packages → repo
  const installDir = join(here, "..", "..", "..");
  const pnpmBin = process.env.HIVEPLANE_PNPM_BIN ?? findOnPath("pnpm");
  if (!pnpmBin) {
    throw new Error(
      "could not find `pnpm` on PATH. Install pnpm or set HIVEPLANE_PNPM_BIN=/abs/path/to/pnpm.",
    );
  }
  const nodeBinDir = dirname(process.execPath);
  return { installDir, pnpmBin, nodeBinDir };
}

function findOnPath(bin: string): string | undefined {
  const sep = process.platform === "win32" ? ";" : ":";
  const dirs = (process.env.PATH ?? "").split(sep);
  for (const dir of dirs) {
    if (!dir) continue;
    const candidate = join(dir, bin);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

/**
 * On Linux, a systemd-user unit only survives reboot if the user has
 * `loginctl enable-linger` set. Without it, the user's systemd instance is
 * torn down at logout and the daemon dies with it. We can't run the linger
 * command ourselves (it requires elevated privileges on most distros), so
 * we detect when it's off and nudge the operator with the exact fix.
 *
 * Best-effort: if `loginctl` is missing or the call fails for any reason we
 * stay silent — this is UX, not correctness.
 */
export function warnIfLingerOff(): void {
  if (process.platform !== "linux") return;
  try {
    const user = process.env.USER ?? process.env.LOGNAME;
    if (!user) return;
    const out = execFileSync("loginctl", ["show-user", user, "--property=Linger"], {
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
    if (out === "Linger=no") {
      console.log("");
      console.log("Note: `loginctl show-user` reports Linger=no. Without linger, your user's");
      console.log("systemd instance stops at logout and the daemon will not survive reboot.");
      console.log(`Enable it once with:  loginctl enable-linger ${user}`);
    }
  } catch {
    // loginctl missing or call failed — silent.
  }
}

/**
 * Tail (or print, when `follow` is false) a daemon log file. Shared by both
 * `bee logs` and `hive logs` to avoid duplicating the naive poll-the-file
 * implementation.
 */
export function runLogsFromFile(logFile: string, follow: boolean): void {
  if (!existsSync(logFile)) {
    console.error(
      `No log file at ${logFile} yet. Service writes logs once it has started at least once.`,
    );
    process.exit(1);
  }

  if (!follow) {
    createReadStream(logFile).pipe(process.stdout);
    return;
  }

  // Naive follow: read existing, then poll for appended bytes. Fine for v0.
  let position = 0;
  const initial = createReadStream(logFile);
  initial.on("data", (chunk) => {
    process.stdout.write(chunk);
    position += chunk.length;
  });
  initial.on("end", () => {
    setInterval(() => {
      const size = statSync(logFile).size;
      if (size > position) {
        const tail = createReadStream(logFile, { start: position, end: size });
        tail.on("data", (chunk) => process.stdout.write(chunk));
        position = size;
      }
    }, 500);
  });
}
