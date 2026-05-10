#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  clearHiveUrl,
  getDefaultHivePlaneConfigDir,
  getHivePlaneConfigPaths,
  loadOrCreateBeeIdentity,
  readHivePlaneConfig,
  writeHivePlaneConfig,
} from "@hiveplane/daemon";

const VERSION = "0.0.1";

type ArgvParseResult = {
  configDir?: string;
  positional: string[];
  flags: Map<string, string | true>;
};

async function main(): Promise<void> {
  // Strip leading global flags (e.g. --config-dir) so the user can put them
  // anywhere on the command line.
  const argv = stripGlobalFlags(process.argv.slice(2));
  if (argv.commandArgs.length === 0) {
    printHelp();
    return;
  }
  const first = argv.commandArgs[0];
  if (first === "--help" || first === "-h") {
    printHelp();
    return;
  }
  if (first === "--version" || first === "-v") {
    console.log(VERSION);
    return;
  }

  const [command, ...rest] = argv.commandArgs;
  const parsed = parseArgs(rest);
  if (argv.configDir) parsed.configDir = argv.configDir;

  switch (command) {
    case "login":
      await runLogin(parsed);
      return;
    case "logout":
      await runLogout(parsed);
      return;
    case "status":
      await runStatus(parsed);
      return;
    case "start":
      await runStart(parsed);
      return;
    case "identity":
      await runIdentity(parsed);
      return;
    case "help":
      printHelp();
      return;
    default:
      console.error(`Unknown command: ${command}`);
      printHelp();
      process.exit(2);
  }
}

async function runLogin(parsed: ArgvParseResult): Promise<void> {
  const url = parsed.positional[0];
  if (!url) {
    console.error("Usage: hive login <hive-url>");
    process.exit(2);
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    console.error(`Invalid URL: ${url}`);
    process.exit(2);
  }
  if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
    console.error(`Hive URL must be http(s): got ${parsedUrl.protocol}`);
    process.exit(2);
  }

  const beeName =
    typeof parsed.flags.get("name") === "string" ? (parsed.flags.get("name") as string) : undefined;
  writeHivePlaneConfig(
    {
      hiveUrl: parsedUrl.toString(),
      ...(beeName ? { beeName } : {}),
    },
    parsed.configDir,
  );

  const identity = await loadOrCreateBeeIdentity(
    parsed.configDir ? { configDir: parsed.configDir } : {},
  );

  console.log(`Logged into ${parsedUrl.toString()}`);
  console.log(`Bee identity: ${identity.fingerprint}`);
  console.log(`Run \`hive start\` to begin heartbeating.`);
}

async function runLogout(parsed: ArgvParseResult): Promise<void> {
  clearHiveUrl(parsed.configDir);
  console.log("Logged out. Hive URL cleared from config.");
}

async function runStatus(parsed: ArgvParseResult): Promise<void> {
  const configDir = parsed.configDir ?? getDefaultHivePlaneConfigDir();
  const paths = getHivePlaneConfigPaths(configDir);
  const config = readHivePlaneConfig(configDir);
  const identityPath = join(configDir, "bee-identity.json");
  const hasIdentity = existsSync(identityPath);

  console.log(`Config dir:    ${paths.configDir}`);
  console.log(`Config file:   ${existsSync(paths.configPath) ? paths.configPath : "(none)"}`);
  console.log(`Hive URL:      ${config.hiveUrl ?? "(not set — run 'hive login <url>')"}`);
  console.log(`Bee name:      ${config.beeName ?? "(unset, defaults to hostname)"}`);

  if (hasIdentity) {
    const identity = await loadOrCreateBeeIdentity(
      parsed.configDir ? { configDir: parsed.configDir } : {},
    );
    console.log(`Identity:      ${identity.fingerprint}`);
    console.log(`Created:       ${identity.createdAt}`);
  } else {
    console.log(`Identity:      (will be generated on first login)`);
  }
}

async function runStart(parsed: ArgvParseResult): Promise<void> {
  const config = readHivePlaneConfig(parsed.configDir);
  if (!config.hiveUrl) {
    console.error("No Hive URL configured. Run `hive login <url>` first.");
    process.exit(2);
  }

  const here = dirname(fileURLToPath(import.meta.url));
  const isCompiled = here.endsWith("/dist") || here.endsWith("\\dist");
  // From dist/index.js: ../../daemon/dist/cli.js. From src/index.ts (dev): ../../daemon/src/cli.ts.
  const daemonEntry = isCompiled
    ? join(here, "..", "..", "daemon", "dist", "cli.js")
    : join(here, "..", "..", "daemon", "src", "cli.ts");

  const nodeArgs = isCompiled ? [daemonEntry] : ["--import", "tsx", daemonEntry];
  if (parsed.configDir) nodeArgs.push("--config-dir", parsed.configDir);

  const child = spawn(process.execPath, nodeArgs, {
    stdio: "inherit",
    env: process.env,
  });
  child.on("exit", (code) => process.exit(code ?? 0));
}

async function runIdentity(parsed: ArgvParseResult): Promise<void> {
  const sub = parsed.positional[0];
  if (sub !== "init" && sub !== "show") {
    console.error("Usage: hive identity (init|show)");
    process.exit(2);
  }
  const identity = await loadOrCreateBeeIdentity(
    parsed.configDir ? { configDir: parsed.configDir } : {},
  );
  if (sub === "init") {
    console.log(`Bee identity ready: ${identity.fingerprint}`);
  } else {
    console.log(JSON.stringify(identity, null, 2));
  }
}

function stripGlobalFlags(args: string[]): { configDir?: string; commandArgs: string[] } {
  const out: string[] = [];
  let configDir: string | undefined;
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i] as string;
    // pnpm forwards "--" as a separator literal; skip it.
    if (a === "--") continue;
    if (a === "--config-dir") {
      configDir = requireValue(args, ++i, "--config-dir");
    } else {
      out.push(a);
    }
  }
  return { ...(configDir ? { configDir } : {}), commandArgs: out };
}

function parseArgs(args: string[]): ArgvParseResult {
  const positional: string[] = [];
  const flags = new Map<string, string | true>();
  let configDir: string | undefined = process.env.HIVEPLANE_CONFIG_DIR;

  for (let i = 0; i < args.length; i += 1) {
    const a = args[i] as string;
    if (a === "--config-dir") {
      configDir = requireValue(args, ++i, "--config-dir");
    } else if (a === "--name") {
      flags.set("name", requireValue(args, ++i, "--name"));
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

function requireValue(args: string[], index: number, flag: string): string {
  const value = args[index];
  if (!value) {
    console.error(`${flag} requires a value`);
    process.exit(2);
  }
  return value;
}

function printHelp(): void {
  console.log(
    `HivePlane CLI v${VERSION}

Usage:
  hive login <url>           Connect this Bee to a Hive (writes ~/.hiveplane/config.json)
  hive logout                Forget the Hive URL (keeps Bee identity)
  hive status                Show config + identity for this machine
  hive start                 Run the Bee daemon in the foreground
  hive identity init|show    Generate or print the Bee Ed25519 identity
  hive --version             Print version
  hive --help                Print this help

Flags:
  --config-dir <path>        Override config dir (default: ~/.hiveplane)
  --name <name>              Friendly Bee name (used by 'hive login')
`,
  );
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
