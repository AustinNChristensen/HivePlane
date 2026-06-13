#!/usr/bin/env node
// `hive` CLI — control-plane operations on the local machine.
//
// v0.0.5 split the old single `hive` CLI into two binaries. The `hive`
// binary is what `hive.sh` drops into `~/.local/bin/`; on a Hive machine
// this is the only CLI you need. The verbs are flat at the top level
// (no more `selfhost` prefix) and don't collide with the `bee` binary's
// surface because they're separate processes.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseArgs,
  resolveInstallEnvironment,
  runLogsFromFile,
  stringFlag,
  stripGlobalFlags,
  VERSION,
  warnIfLingerOff,
  type ArgvParseResult,
} from "./_shared.js";
import { getDefaultHivePlaneConfigDir } from "@hiveplane/daemon";
import {
  generateAdminToken,
  getHiveConfigPath,
  readHiveOnDiskConfig,
  writeHiveOnDiskConfig,
  type HiveOnDiskConfig,
} from "./hive-config.js";
import { probeHiveVersion, probePortInUse } from "./port-probe.js";
import {
  getDaemonLogFiles,
  getHiveServiceStatus,
  getServicePlatform,
  installHiveService,
  restartHiveService,
  startHiveService,
  stopHiveService,
  uninstallHiveService,
} from "./service.js";

async function main(): Promise<void> {
  const argv = stripGlobalFlags(process.argv.slice(2));
  if (argv.commandArgs.length === 0) {
    printHelp();
    return;
  }
  const first = argv.commandArgs[0];
  if (first === "--help" || first === "-h" || first === "help") {
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
    case "init":
      await runInit(parsed);
      return;
    case "install":
      await runInstall(parsed);
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
    case "status":
      await runStatus(parsed);
      return;
    case "uninstall":
      await runUninstall();
      return;
    case "logs":
      await runLogs(parsed);
      return;
    case "up":
      await runUp(parsed);
      return;
    default:
      console.error(`Unknown command: ${command}`);
      printHelp();
      process.exit(2);
  }
}

/**
 * Persist the on-disk Hive config. If a config already exists we preserve
 * its admin token (and any other set fields) and only fill in defaults for
 * what's missing. `hive up` calls this under the hood, and it's also safe
 * to run on its own to inspect or rotate the admin token.
 */
async function runInit(parsed: ArgvParseResult): Promise<void> {
  const configDir = parsed.configDir ?? getDefaultHivePlaneConfigDir();
  const existing = readHiveOnDiskConfig(configDir);

  // Flag overrides — let `hive.sh` (and operators tweaking after the fact)
  // pin host/port without hand-editing the JSON.
  const hostFlag = stringFlag(parsed, "host");
  const portFlag = stringFlag(parsed, "port");
  const authRequiredFlag =
    parsed.flags.get("auth-required") === true
      ? true
      : parsed.flags.get("auth-required") === "false"
        ? false
        : undefined;

  const resolvedPort = portFlag !== undefined ? Number(portFlag) : (existing.port ?? 4483);
  if (!Number.isInteger(resolvedPort) || resolvedPort <= 0) {
    console.error(`Invalid --port: ${portFlag}`);
    process.exit(2);
  }

  const config: HiveOnDiskConfig = {
    adminToken: existing.adminToken ?? generateAdminToken(),
    host: hostFlag ?? existing.host ?? "0.0.0.0",
    port: resolvedPort,
    authRequired: authRequiredFlag ?? existing.authRequired ?? false,
    openBrowser: existing.openBrowser ?? false,
  };
  if (existing.incidentNotificationWebhookUrl) {
    config.incidentNotificationWebhookUrl = existing.incidentNotificationWebhookUrl;
  }
  if (existing.incidentNotificationCommand) {
    config.incidentNotificationCommand = existing.incidentNotificationCommand;
  }
  const overwriteAdmin = parsed.flags.get("rotate-admin-token") === true;
  if (overwriteAdmin) config.adminToken = generateAdminToken();

  const { path } = writeHiveOnDiskConfig(config, configDir);
  console.log(`Wrote ${path} (mode 0600).`);
  console.log(`  host:          ${config.host}`);
  console.log(`  port:          ${config.port}`);
  console.log(`  authRequired:  ${config.authRequired}`);
  console.log(`  openBrowser:   ${config.openBrowser}`);
  if (existing.adminToken && !overwriteAdmin) {
    console.log(`  adminToken:    (preserved — pass --rotate-admin-token to mint a fresh one)`);
  } else {
    console.log(`  adminToken:    ${config.adminToken}`);
    console.log(`  ↑ save this. It's the only key for the Hive admin endpoints.`);
  }
}

async function runInstall(parsed: ArgvParseResult): Promise<void> {
  ensureHiveConfigOrExit(parsed.configDir);
  const env = resolveInstallEnvironment(dirname(fileURLToPath(import.meta.url)));
  const result = installHiveService({
    installDir: env.installDir,
    pnpmBin: env.pnpmBin,
    nodeBinDir: env.nodeBinDir,
    configDir: parsed.configDir ?? getDefaultHivePlaneConfigDir(),
  });
  console.log(`Wrote unit file (${result.platform}): ${result.unitPath}`);
  console.log(`Run \`hive start\` to launch.`);
}

async function runStart(parsed: ArgvParseResult): Promise<void> {
  const configDir = ensureHiveConfigOrExit(parsed.configDir);
  if (getServicePlatform() === "unsupported") {
    console.error(
      `Hive auto-start is not supported on ${process.platform}. Run the Hive in the foreground:`,
    );
    console.error(`  pnpm --filter @hiveplane/web start -- --no-open`);
    process.exit(2);
  }

  // Defense in depth against the port-collision class — refuse rather than
  // launching a service that will silently crash-loop under launchd.
  const cfg = readHiveOnDiskConfig(configDir);
  const port = cfg.port ?? 4483;
  const status = await getHiveServiceStatus(configDir);
  if (!status.running) {
    const probe = probePortInUse(port);
    if (probe.listening === true) {
      console.error(
        `Refusing to start: port ${port} is already in use:\n\n${probe.details}\n\n` +
          `Pick a different port with \`hive init --port <n>\`, or stop the conflicting process first.`,
      );
      process.exit(2);
    }
  }

  if (!status.installed) {
    const env = resolveInstallEnvironment(dirname(fileURLToPath(import.meta.url)));
    const result = installHiveService({
      installDir: env.installDir,
      pnpmBin: env.pnpmBin,
      nodeBinDir: env.nodeBinDir,
      configDir,
    });
    console.log(`Installed Hive service unit (${result.platform}): ${result.unitPath}`);
  }
  await startHiveService();
  console.log(`Hive started. Dashboard: http://localhost:${port}/`);
  console.log(`Tail logs with \`hive logs -f\`. Stop with \`hive stop\`.`);
  warnIfLingerOff();
}

async function runStop(): Promise<void> {
  await stopHiveService();
  console.log("Hive stopped.");
}

async function runRestart(): Promise<void> {
  await restartHiveService();
  console.log("Hive restarted.");
}

async function runStatus(parsed: ArgvParseResult): Promise<void> {
  const configDir = parsed.configDir ?? getDefaultHivePlaneConfigDir();
  const cfg = readHiveOnDiskConfig(configDir);
  const status = await getHiveServiceStatus(configDir);

  console.log(`Config file:   ${getHiveConfigPath(configDir)}`);
  console.log(
    `Admin token:   ${cfg.adminToken ? "(set; run `hive init` to view/rotate)" : "(unset — admin endpoints disabled)"}`,
  );
  console.log(`Bind:          ${cfg.host ?? "(default 0.0.0.0)"}:${cfg.port ?? "(default 4483)"}`);
  console.log(`authRequired:  ${cfg.authRequired ?? false}`);

  const stateLabel =
    status.platform === "unsupported"
      ? "(unsupported on this platform)"
      : status.installed
        ? `installed${status.running ? ", running" : ", not running"}`
        : "not installed (run `hive install`)";
  console.log(`Service:       ${stateLabel}`);
  if (status.unitPath) console.log(`Unit file:     ${status.unitPath}`);
  console.log(`Logs:          ${status.logDir}`);
  if (status.lastExitCode !== undefined && status.lastExitCode !== 0) {
    console.log(`Last exit:     ${status.lastExitCode}`);
  }

  // /version probe — surfaces the launchd-shadowed-by-loopback-bind case
  // where the unit is "running" but a different process is what's actually
  // answering on the bound port. Skipped when the service is known not to
  // be running.
  if (status.installed && status.running) {
    const port = cfg.port ?? 4483;
    const host = cfg.host ?? "127.0.0.1";
    const result = await probeHiveVersion(host, port);
    switch (result.kind) {
      case "hive":
        console.log(`Health probe:  /version → hiveplane-hive ${result.version} ✓`);
        break;
      case "stranger":
        console.log(
          `Health probe:  /version → ⚠️  another process answered on port ${port}.\n` +
            `               The Hive launchd unit is "running" but is being shadowed; check\n` +
            `               \`lsof -nP -iTCP:${port} -sTCP:LISTEN\` for the squatter.`,
        );
        break;
      case "unreachable":
        console.log(
          `Health probe:  /version → unreachable (${result.reason}). Check \`hive logs -f\`.`,
        );
        break;
    }
  }
}

async function runUninstall(): Promise<void> {
  const result = uninstallHiveService();
  if (result.unitRemoved) {
    console.log(`Hive service disabled. Removed: ${result.unitPath}`);
  } else {
    console.log("Hive service was not installed; nothing to do.");
  }
}

async function runLogs(parsed: ArgvParseResult): Promise<void> {
  const configDir = parsed.configDir ?? getDefaultHivePlaneConfigDir();
  const status = await getHiveServiceStatus(configDir);
  const follow = parsed.flags.get("follow") === true || parsed.flags.get("f") === true;
  const stream = parsed.positional[0] === "stderr" ? "err" : "out";
  const logFiles = getDaemonLogFiles("hive", configDir);
  const logFile = stream === "err" ? logFiles.stderr : logFiles.stdout;

  if (status.platform === "linux") {
    const args = ["--user", "-u", "hiveplane-hive.service", "--no-pager"];
    if (follow) args.push("-f");
    const child = spawn("journalctl", args, { stdio: "inherit" });
    // Minimal Linux environments (containers, WSL1) may not ship journalctl
    // — fall through to file logs rather than dying with a confusing ENOENT.
    let spawned = false;
    child.on("spawn", () => {
      spawned = true;
    });
    child.on("error", (err) => {
      if (!spawned && (err as NodeJS.ErrnoException).code === "ENOENT") {
        console.warn(`journalctl not on PATH; falling back to file logs at ${status.logDir}.`);
        runLogsFromFile(logFile, follow);
        return;
      }
      console.error(`journalctl failed: ${err.message}`);
      process.exit(1);
    });
    child.on("exit", (code) => {
      if (spawned) process.exit(code ?? 0);
    });
    return;
  }

  runLogsFromFile(logFile, follow);
}

async function runUp(parsed: ArgvParseResult): Promise<void> {
  await runInit(parsed);
  await runStart(parsed);
}

/**
 * Read the Hive config and abort with a clear error if no admin token has
 * been set yet. Returns the resolved config dir on success so callers don't
 * have to re-derive it.
 */
function ensureHiveConfigOrExit(configDirOverride: string | undefined): string {
  const configDir = configDirOverride ?? getDefaultHivePlaneConfigDir();
  const cfg = readHiveOnDiskConfig(configDir);
  if (!cfg.adminToken) {
    console.error(
      `No Hive config at ${getHiveConfigPath(configDir)} (or no adminToken set). Run \`hive init\` first.`,
    );
    process.exit(2);
  }
  return configDir;
}

function printHelp(): void {
  console.log(
    `HivePlane Hive CLI v${VERSION}

Usage:
  hive init [--port <n>] [--rotate-admin-token]
                             Generate or update ~/.hiveplane/hive-config.json
                             (creates an admin token if missing).
  hive install               Install the launchd/systemd unit for the Hive
                             (no-op if already present).
  hive start                 Start the Hive service. Auto-installs the unit
                             on first run; refuses if the port is taken.
  hive stop                  Stop the Hive service.
  hive restart               Stop + start.
  hive status                Show install/running state, /version health
                             probe, log paths.
  hive uninstall             Stop the service and remove the unit file.
  hive logs [stderr] [-f]    Print or tail Hive logs (default: stdout).
  hive up [--port <n>]       init + install + start in one shot.
  hive --version             Print version
  hive --help                Print this help

Flags:
  --config-dir <path>        Override config dir (default: ~/.hiveplane)
  --host <addr>              Bind host for 'init' / 'up' (default 0.0.0.0)
  --port <n>                 Bind port for 'init' / 'up' (default 4483)
  --rotate-admin-token       'init': mint a fresh admin token
  --auth-required true|false 'init': require signed heartbeats
  -f, --follow               'logs' tails the file
`,
  );
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
