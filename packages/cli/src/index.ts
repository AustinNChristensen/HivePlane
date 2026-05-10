#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createReadStream, existsSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  clearHiveSession,
  clearHiveUrl,
  getDefaultHivePlaneConfigDir,
  getHivePlaneConfigPaths,
  loadOrCreateBeeIdentity,
  readHivePlaneConfig,
  readHiveSession,
  registerBeeWithHive,
  writeHivePlaneConfig,
  writeHiveSession,
} from "@hiveplane/daemon";
import {
  getBeeServiceStatus,
  getServicePlatform,
  installBeeService,
  restartBeeService,
  startBeeService,
  stopBeeService,
  uninstallBeeService,
} from "./service.js";

const VERSION = "0.0.1";

type ArgvParseResult = {
  configDir?: string;
  positional: string[];
  flags: Map<string, string | true>;
};

async function main(): Promise<void> {
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
    case "stop":
      await runStop();
      return;
    case "restart":
      await runRestart();
      return;
    case "enable":
      await runEnable(parsed);
      return;
    case "disable":
      await runDisable();
      return;
    case "logs":
      await runLogs(parsed);
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
    console.error("Usage: hive login <hive-url> [--token <bootstrap>]");
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

  // If a bootstrap token was supplied, register so the daemon can use signed heartbeats.
  const tokenFlag = parsed.flags.get("token");
  if (typeof tokenFlag === "string") {
    try {
      const response = await registerBeeWithHive({
        hiveUrl: parsedUrl.toString(),
        bootstrapToken: tokenFlag,
        identity,
        ...(beeName ? { beeName } : {}),
        daemonVersion: VERSION,
      });
      writeHiveSession(
        {
          hiveUrl: parsedUrl.toString(),
          beeId: response.beeId,
          sessionToken: response.sessionToken,
          sessionExpiresAt: response.sessionExpiresAt,
        },
        parsed.configDir,
      );
      console.log(`Registered with Hive as ${response.beeId} (signed-heartbeat mode).`);
    } catch (error) {
      console.error(
        `Registration failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      console.error(
        "Hive URL was saved. You can retry with `hive login <url> --token <new-token>`.",
      );
      process.exit(1);
    }
  }

  // If a service unit is already installed, restart it so it picks up the new URL.
  const status = await getBeeServiceStatus(parsed.configDir ?? getDefaultHivePlaneConfigDir());
  if (status.installed) {
    try {
      await restartBeeService();
      console.log(`Service restarted (${status.platform}). Heartbeating now.`);
    } catch (error) {
      console.error(
        `Service restart failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      console.error(`Try \`hive start\`.`);
    }
  } else {
    console.log(`Run \`hive start\` to begin heartbeating.`);
  }
}

async function runLogout(parsed: ArgvParseResult): Promise<void> {
  // Stop the service so the daemon doesn't keep heartbeating to the old Hive.
  try {
    await stopBeeService();
  } catch {
    // not installed or not running — fine
  }
  clearHiveUrl(parsed.configDir);
  clearHiveSession(parsed.configDir);
  console.log("Logged out. Hive URL + session cleared from config.");
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

  const session = readHiveSession(configDir);
  if (session) {
    const expired = new Date(session.sessionExpiresAt).getTime() <= Date.now();
    console.log(
      `Session:       ${expired ? "expired" : "active"} (beeId=${session.beeId}, expires ${session.sessionExpiresAt})`,
    );
  } else {
    console.log(`Session:       (none — register with \`hive login <url> --token <bootstrap>\`)`);
  }

  const status = await getBeeServiceStatus(configDir);
  const stateLabel =
    status.platform === "unsupported"
      ? "(unsupported on this platform — `hive start` will run in foreground)"
      : status.installed
        ? `installed${status.running ? ", running" : ", not running"}`
        : "not installed (will be installed on `hive start`)";
  console.log(`Service:       ${stateLabel}`);
  if (status.unitPath) {
    console.log(`Unit file:     ${status.unitPath}`);
  }
  console.log(`Logs:          ${status.logDir}`);
  if (status.lastExitCode !== undefined && status.lastExitCode !== 0) {
    console.log(`Last exit:     ${status.lastExitCode}`);
  }
}

async function runStart(parsed: ArgvParseResult): Promise<void> {
  const configDir = parsed.configDir ?? getDefaultHivePlaneConfigDir();
  const config = readHivePlaneConfig(configDir);
  if (!config.hiveUrl) {
    console.error("No Hive URL configured. Run `hive login <url>` first.");
    process.exit(2);
  }

  const foreground = parsed.flags.get("foreground") === true;

  // On a supported platform, ensure the daemon runs as a real service unit
  // (auto-installs on first run, survives reboots). Foreground mode is the
  // explicit dev-only escape hatch.
  if (!foreground && getServicePlatform() !== "unsupported") {
    const status = await getBeeServiceStatus(configDir);
    if (!status.installed) {
      const env = resolveInstallEnvironment();
      const result = installBeeService({
        installDir: env.installDir,
        pnpmBin: env.pnpmBin,
        nodeBinDir: env.nodeBinDir,
        configDir,
      });
      console.log(`Installed service unit (${result.platform}): ${result.unitPath}`);
    }
    await startBeeService();
    console.log(`Started. Tail logs with \`hive logs -f\`. Stop with \`hive stop\`.`);
    return;
  }

  // Foreground / unsupported-platform fallback.
  if (!foreground) {
    console.warn(`auto-start unsupported on ${process.platform}; running in the foreground.`);
  }
  const here = dirname(fileURLToPath(import.meta.url));
  const isCompiled = here.endsWith("/dist") || here.endsWith("\\dist");
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

async function runStop(): Promise<void> {
  await stopBeeService();
  console.log("Stopped.");
}

async function runRestart(): Promise<void> {
  await restartBeeService();
  console.log("Restarted.");
}

async function runEnable(parsed: ArgvParseResult): Promise<void> {
  // Power-user alias: same effect as `hive start`, but with --no-start
  // available for "install the unit but don't start it yet".
  const configDir = parsed.configDir ?? getDefaultHivePlaneConfigDir();
  const config = readHivePlaneConfig(configDir);
  if (!config.hiveUrl) {
    console.error("No Hive URL configured. Run `hive login <url>` first.");
    process.exit(2);
  }

  const installInfo = resolveInstallEnvironment();
  const result = installBeeService({
    installDir: installInfo.installDir,
    pnpmBin: installInfo.pnpmBin,
    nodeBinDir: installInfo.nodeBinDir,
    configDir,
  });

  console.log(`Wrote unit file: ${result.unitPath}`);

  const startNow = parsed.flags.get("no-start") !== true;
  if (startNow) {
    await startBeeService();
    console.log(`Service enabled and started (${result.platform}).`);
    console.log(`Tail logs with \`hive logs -f\`.`);
  } else {
    console.log(`Service enabled (${result.platform}). Run \`hive start\` to launch.`);
  }
}

async function runDisable(): Promise<void> {
  const result = uninstallBeeService();
  if (result.unitRemoved) {
    console.log(`Service disabled. Removed: ${result.unitPath}`);
  } else {
    console.log("Service was not installed; nothing to do.");
  }
}

async function runLogs(parsed: ArgvParseResult): Promise<void> {
  const configDir = parsed.configDir ?? getDefaultHivePlaneConfigDir();
  const status = await getBeeServiceStatus(configDir);
  const follow = parsed.flags.get("follow") === true || parsed.flags.get("f") === true;
  const stream = parsed.positional[0] === "stderr" ? "err" : "out";
  const logFile = join(status.logDir, `bee.${stream}.log`);

  if (status.platform === "linux") {
    const args = ["--user", "-u", "hiveplane-bee.service", "--no-pager"];
    if (follow) args.push("-f");
    const child = spawn("journalctl", args, { stdio: "inherit" });
    child.on("exit", (code) => process.exit(code ?? 0));
    return;
  }

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

type InstallEnvironment = { installDir: string; pnpmBin: string; nodeBinDir: string };

function resolveInstallEnvironment(): InstallEnvironment {
  const here = dirname(fileURLToPath(import.meta.url));
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

function stripGlobalFlags(args: string[]): { configDir?: string; commandArgs: string[] } {
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
    } else if (a === "--token") {
      flags.set("token", requireValue(args, ++i, "--token"));
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
  hive login <url> [--token <bootstrap>]
                             Connect this Bee to a Hive. With --token, register
                             and persist a session for signed heartbeats.
  hive logout                Forget the Hive URL + session, stop the service
  hive status                Show config, identity, session, and service state
  hive start                 Start the daemon. Auto-installs the launchd/systemd
                             unit on first run; restarts it next time.
                             --foreground runs as a child process for dev.
  hive stop                  Stop the running service
  hive restart               Restart the service
  hive enable [--no-start]   Power-user: install the unit file explicitly
  hive disable               Power-user: stop + remove the unit file
  hive logs [stderr] [-f]    Print or tail daemon logs (default stdout)
  hive identity init|show    Generate or print the Bee Ed25519 identity
  hive --version             Print version
  hive --help                Print this help

Flags:
  --config-dir <path>        Override config dir (default: ~/.hiveplane)
  --name <name>              Friendly Bee name (used by 'hive login')
  --token <bootstrap>        Bootstrap token (from \`hive bee token create\`)
  --foreground               'hive start' runs as a child process, not a service
  --no-start                 'hive enable': install unit but don't start it
  -f, --follow               'hive logs' tails the file
`,
  );
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
