#!/usr/bin/env node
// `bee` CLI — worker-daemon operations on the local machine.
//
// v0.0.5 split the old single `hive` CLI into two binaries. The `bee`
// binary is what `bee.sh` drops into `~/.local/bin/`; on a Bee machine
// this is the only CLI you need. (The control-plane verbs that used to
// live under `hive selfhost <verb>` now live on the `hive` binary at the
// top level, installed by `hive.sh`.)
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { hostname as osHostname } from "node:os";
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
  parseArgs,
  promptLine,
  resolveInstallEnvironment,
  runLogsFromFile,
  stripGlobalFlags,
  VERSION,
  warnIfLingerOff,
  type ArgvParseResult,
} from "./_shared.js";
import { classifyCredential } from "./credentials.js";
import {
  getBeeServiceStatus,
  getServicePlatform,
  installBeeService,
  restartBeeService,
  startBeeService,
  stopBeeService,
  uninstallBeeService,
} from "./service.js";

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
  // Resolve URL: from positional, or interactively if stdin is a TTY.
  let url = parsed.positional[0];
  const interactive = process.stdin.isTTY === true;

  if (!url) {
    if (!interactive) {
      console.error("Usage: bee login <hive-url> [--token <bootstrap>] [--pairing-key <key>]");
      process.exit(2);
    }
    url = (await promptLine("Hive URL: ")).trim();
    if (!url) {
      console.error("Hive URL is required.");
      process.exit(2);
    }
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

  // Resolve credential. Precedence: --token > --pairing-key > interactive prompt.
  // Either flag accepts either form (we sniff the prefix), so scripted callers
  // and operators copy-pasting from the dashboard both work.
  let credentialFlag = pickCredentialFlag(parsed);
  if (!credentialFlag && interactive) {
    const typed = (await promptLine("Pairing key (or bootstrap token, blank to skip): ")).trim();
    if (typed) credentialFlag = typed;
  }

  let beeName =
    typeof parsed.flags.get("name") === "string" ? (parsed.flags.get("name") as string) : undefined;
  if (!beeName && interactive && !parsed.positional[0]) {
    // Only prompt for the name in fully-guided mode (no positional URL given).
    const defaultName = osHostname();
    const typed = (await promptLine(`Bee name [${defaultName}]: `)).trim();
    if (typed) beeName = typed;
  }

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

  // If a credential was supplied, register so the daemon can use signed heartbeats.
  if (credentialFlag) {
    const credential = classifyCredential(credentialFlag);
    if (!credential) {
      console.error(
        `Could not recognize the credential. Expected an 8-character pairing key (e.g. K7RQ-2P9X) or a bootstrap token starting with "hp_boot_".`,
      );
      process.exit(2);
    }
    try {
      const response = await registerBeeWithHive({
        hiveUrl: parsedUrl.toString(),
        ...(credential.kind === "bootstrap"
          ? { bootstrapToken: credential.value }
          : { pairingKey: credential.value }),
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
        "Hive URL was saved. You can retry with `bee login <url> --token <new-token>`.",
      );
      process.exit(1);
    }
  }

  // Auto-start the Bee daemon after a successful registration.
  //
  // v0.0.6 left this as an explicit two-step (`bee login`, then `bee start`)
  // and almost every operator forgot the second step — the heartbeat counter
  // stays at 0 forever, the dashboard shows the Bee as `offline` despite a
  // green pair. The right default is "you paired, you want it running".
  //
  // Honored escape hatches:
  //   --no-start         — skip auto-start (provisioning scripts, dev)
  //   --foreground       — runStart respects this and runs as a child
  //   no credential      — we didn't actually pair, so don't start a
  //                        daemon that has no session to heartbeat with
  const noStart = parsed.flags.get("no-start") === true;
  if (!noStart && credentialFlag) {
    await runStart(parsed);
    return;
  }

  // Fallback: didn't auto-start (either --no-start, or no credential supplied
  // and we only updated the URL). If a unit is already installed, restart it
  // so it picks up any new URL; otherwise nudge the operator.
  const status = await getBeeServiceStatus(parsed.configDir ?? getDefaultHivePlaneConfigDir());
  if (status.installed) {
    try {
      await restartBeeService();
      console.log(`Service restarted (${status.platform}). Heartbeating now.`);
    } catch (error) {
      console.error(
        `Service restart failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      console.error(`Try \`bee start\`.`);
    }
  } else {
    console.log(`Run \`bee start\` to begin heartbeating.`);
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
  console.log(`Hive URL:      ${config.hiveUrl ?? "(not set — run 'bee login <url>')"}`);
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
    console.log(
      `Session:       (none — run \`bee login\` and paste the Hive's pairing key when prompted)`,
    );
  }

  const status = await getBeeServiceStatus(configDir);
  const stateLabel =
    status.platform === "unsupported"
      ? "(unsupported on this platform — `bee start` will run in foreground)"
      : status.installed
        ? `installed${status.running ? ", running" : ", not running"}`
        : "not installed (will be installed on `bee start`)";
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
    console.error("No Hive URL configured. Run `bee login <url>` first.");
    process.exit(2);
  }

  const foreground = parsed.flags.get("foreground") === true;

  // On a supported platform, ensure the daemon runs as a real service unit
  // (auto-installs on first run, survives reboots). Foreground mode is the
  // explicit dev-only escape hatch.
  if (!foreground && getServicePlatform() !== "unsupported") {
    const status = await getBeeServiceStatus(configDir);
    if (!status.installed) {
      const env = resolveInstallEnvironment(dirname(fileURLToPath(import.meta.url)));
      const result = installBeeService({
        installDir: env.installDir,
        pnpmBin: env.pnpmBin,
        nodeBinDir: env.nodeBinDir,
        configDir,
      });
      console.log(`Installed service unit (${result.platform}): ${result.unitPath}`);
    }
    await startBeeService();
    console.log(`Started. Tail logs with \`bee logs -f\`. Stop with \`bee stop\`.`);
    warnIfLingerOff();
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
  // Power-user alias: same effect as `bee start`, but with --no-start
  // available for "install the unit but don't start it yet".
  const configDir = parsed.configDir ?? getDefaultHivePlaneConfigDir();
  const config = readHivePlaneConfig(configDir);
  if (!config.hiveUrl) {
    console.error("No Hive URL configured. Run `bee login <url>` first.");
    process.exit(2);
  }

  const env = resolveInstallEnvironment(dirname(fileURLToPath(import.meta.url)));
  const result = installBeeService({
    installDir: env.installDir,
    pnpmBin: env.pnpmBin,
    nodeBinDir: env.nodeBinDir,
    configDir,
  });

  console.log(`Wrote unit file: ${result.unitPath}`);

  const startNow = parsed.flags.get("no-start") !== true;
  if (startNow) {
    await startBeeService();
    console.log(`Service enabled and started (${result.platform}).`);
    console.log(`Tail logs with \`bee logs -f\`.`);
  } else {
    console.log(`Service enabled (${result.platform}). Run \`bee start\` to launch.`);
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
    // Minimal containers / WSL1 / some systemd-less distros don't ship
    // `journalctl`. Fall through to the file-based reader rather than
    // exiting with a confusing ENOENT spawn error.
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

async function runIdentity(parsed: ArgvParseResult): Promise<void> {
  const sub = parsed.positional[0];
  if (sub !== "init" && sub !== "show") {
    console.error("Usage: bee identity (init|show)");
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

/**
 * Pull a credential off `--token` or `--pairing-key`, in that order. Both flags
 * accept either form — we sniff the prefix downstream — so a user pasting from
 * the dashboard's bootstrap-token UI into `--pairing-key` (or vice versa)
 * still pairs successfully.
 */
function pickCredentialFlag(parsed: ArgvParseResult): string | undefined {
  const token = parsed.flags.get("token");
  if (typeof token === "string") return token;
  const pairing = parsed.flags.get("pairing-key");
  if (typeof pairing === "string") return pairing;
  return undefined;
}

function printHelp(): void {
  console.log(
    `HivePlane Bee CLI v${VERSION}

Usage:
  bee login [<url>] [--pairing-key <key>] [--token <bootstrap>] [--no-start]
                             Connect this Bee to a Hive and start the daemon.
                             Run with no args on a TTY for a guided prompt
                             (URL, then pairing key). --pairing-key takes
                             the short 8-char code shown on the Hive
                             dashboard. --token takes a long admin-minted
                             bootstrap token (for scripts). After a
                             successful pair, the service unit is auto-
                             installed and started — pass --no-start to
                             skip that (e.g. for provisioning scripts).
  bee logout                 Forget the Hive URL + session, stop the service
  bee status                 Show config, identity, session, and service state
  bee start                  Start the daemon. Auto-installs the launchd/systemd
                             unit on first run; restarts it next time.
                             --foreground runs as a child process for dev.
  bee stop                   Stop the running service
  bee restart                Restart the service
  bee enable [--no-start]    Power-user: install the unit file explicitly
  bee disable                Power-user: stop + remove the unit file
  bee logs [stderr] [-f]     Print or tail daemon logs (default stdout)
  bee identity init|show     Generate or print the Bee Ed25519 identity
  bee --version              Print version
  bee --help                 Print this help

Flags:
  --config-dir <path>        Override config dir (default: ~/.hiveplane)
  --name <name>              Friendly Bee name (used by 'bee login')
  --pairing-key <key>        Short pairing key from the Hive dashboard
  --token <bootstrap>        Bootstrap token (long, scripted-install form)
  --foreground               'bee start' runs as a child process, not a service
  --no-start                 'bee login' / 'bee enable': install unit but
                             don't start the daemon (default is auto-start)
  -f, --follow               'bee logs' tails the file
`,
  );
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
