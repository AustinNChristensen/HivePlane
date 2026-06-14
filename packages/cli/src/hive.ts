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
import { hostname as osHostname } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  boolFlag,
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

type ProvisionLogLevel = "info" | "warn" | "error";

type ProvisionProfile = {
  id: string;
  label: string;
  policyProfile: string;
};

const PROVISION_PROFILES: Record<string, ProvisionProfile> = {
  "macos-openclaw": {
    id: "macos-openclaw",
    label: "macOS OpenClaw workstation",
    policyProfile: "personal_assistant",
  },
  "linux-openclaw": {
    id: "linux-openclaw",
    label: "Linux OpenClaw workstation",
    policyProfile: "personal_assistant",
  },
  "server-worker": {
    id: "server-worker",
    label: "Always-on server worker",
    policyProfile: "server_worker",
  },
  "dev-box": {
    id: "dev-box",
    label: "Developer box",
    policyProfile: "dev_box",
  },
  "read-only": {
    id: "read-only",
    label: "Read-only observer",
    policyProfile: "read_only_observer",
  },
};

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
    case "login":
      runRemoteLogin(parsed);
      return;
    case "daemon":
      await runDaemon(parsed);
      return;
    case "node":
      await runNode(parsed);
      return;
    case "job":
      runJob(parsed);
      return;
    case "approval":
      runApproval(parsed);
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
  console.log(`Hive started. Dashboard: http://localhost:${port}/dashboard`);
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

function runRemoteLogin(parsed: ArgvParseResult): never {
  if (!parsed.positional[0]) {
    console.error("Usage: hive login <hive-url> --token <admin-token>");
    process.exit(2);
  }
  notImplemented(
    "hive login",
    "remote Hive auth profiles are not wired yet; use `hive init` on the Hive host for now.",
  );
}

async function runDaemon(parsed: ArgvParseResult): Promise<void> {
  const [subcommand, ...rest] = parsed.positional;
  const nested = parseArgs(rest);
  if (parsed.configDir) nested.configDir = parsed.configDir;

  switch (subcommand) {
    case "start":
      await runStart(nested);
      return;
    case "status":
      await runStatus(nested);
      return;
    case "stop":
      await runStop();
      return;
    case "restart":
      await runRestart();
      return;
    case "logs":
      await runLogs(nested);
      return;
    default:
      console.error("Usage: hive daemon (start|status|stop|restart|logs)");
      process.exit(2);
  }
}

async function runNode(parsed: ArgvParseResult): Promise<void> {
  const [subcommand, methodOrTarget, maybeTarget] = parsed.positional;
  if (subcommand === "register") {
    notImplemented(
      "hive node register",
      "Bee registration is currently performed by `bee login` and the Hive pairing API.",
    );
  }
  if (subcommand === "provision" && methodOrTarget === "ssh" && maybeTarget) {
    await runNodeProvisionSsh(parsed, maybeTarget);
    return;
  }

  console.error("Usage: hive node register | hive node provision ssh <user@host>");
  process.exit(2);
}

async function runNodeProvisionSsh(parsed: ArgvParseResult, target: string): Promise<void> {
  const json = parsed.flags.get("json") === true;
  const dryRun = parsed.flags.get("dry-run") === true;
  const healthcheckOnly = parsed.flags.get("healthcheck-only") === true;
  const sshBin = stringFlag(parsed, "ssh-bin") ?? process.env.HIVEPLANE_SSH_BIN ?? "ssh";
  const profile = resolveProvisionProfile(stringFlag(parsed, "profile"));
  const configDir = parsed.configDir ?? getDefaultHivePlaneConfigDir();
  const hiveUrl = resolveProvisionHiveUrl(parsed, configDir);
  const beeName = stringFlag(parsed, "name") ?? target.replace(/[@:]/g, "-");

  if (boolFlag(parsed, "store-ssh-credentials") === true) {
    emitProvisionLog(json, "error", "validate", "SSH credential persistence is not supported.");
    console.error("HivePlane does not store SSH passwords or private keys for MVP provisioning.");
    process.exit(2);
  }

  emitProvisionLog(json, "info", "ssh.healthcheck", `checking SSH access to ${target}`, {
    target,
  });
  await runSshCommand({
    sshBin,
    target,
    remoteCommand:
      "printf 'hiveplane.remote.ok\\n'; uname -s; command -v sh >/dev/null; command -v curl >/dev/null; command -v git >/dev/null; command -v node >/dev/null; node -e 'process.exit(Number(process.versions.node.split(\".\")[0]) >= 20 ? 0 : 1)'",
    json,
    dryRun,
  });

  if (healthcheckOnly) {
    emitProvisionLog(json, "info", "complete", "remote SSH healthcheck passed");
    return;
  }

  if (dryRun) {
    const installUrl = new URL("/install/bee.sh", ensureTrailingSlash(hiveUrl)).toString();
    emitProvisionLog(json, "info", "dry-run", "would mint a bootstrap token and run installer", {
      target,
      hiveUrl,
      installUrl,
      beeName,
      profile: profile.id,
      policyProfile: profile.policyProfile,
    });
    return;
  }

  const adminToken = stringFlag(parsed, "token") ?? readHiveOnDiskConfig(configDir).adminToken;
  if (!adminToken) {
    console.error(
      `No admin token available. Pass --token <admin-token> or run this from a Hive with ${getHiveConfigPath(configDir)}.`,
    );
    process.exit(2);
  }

  emitProvisionLog(json, "info", "bootstrap-token.create", `minting token for ${beeName}`, {
    beeName,
  });
  const bootstrapToken = await createRemoteBootstrapToken({
    hiveUrl,
    adminToken,
    beeName,
  });

  const installUrl = new URL("/install/bee.sh", ensureTrailingSlash(hiveUrl)).toString();
  const remoteScript = buildProvisionRemoteScript({
    hiveUrl,
    installUrl,
    bootstrapToken,
    beeName,
    profile,
  });

  emitProvisionLog(
    json,
    "info",
    "bootstrap.run",
    `installing and pairing Bee on ${target} (${profile.label})`,
    { target, hiveUrl, profile: profile.id },
  );
  await runSshCommand({
    sshBin,
    target,
    remoteCommand: "sh -s",
    stdin: remoteScript,
    json,
  });
  emitProvisionLog(json, "info", "complete", `remote Bee provisioned as ${beeName}`, {
    target,
    hiveUrl,
    beeName,
  });
}

function resolveProvisionProfile(profileFlag: string | undefined): ProvisionProfile {
  const id = profileFlag ?? "macos-openclaw";
  const profile = PROVISION_PROFILES[id];
  if (!profile) {
    console.error(`Unknown provisioning profile: ${id}`);
    console.error(`Available profiles: ${Object.keys(PROVISION_PROFILES).join(", ")}`);
    process.exit(2);
  }
  return profile;
}

function resolveProvisionHiveUrl(parsed: ArgvParseResult, configDir: string): string {
  const explicit = stringFlag(parsed, "hive-url") ?? process.env.HIVEPLANE_HIVE_URL;
  if (explicit) return normalizeHiveUrlOrExit(explicit);

  const cfg = readHiveOnDiskConfig(configDir);
  const port = cfg.port ?? 4483;
  const host = cfg.host && cfg.host !== "0.0.0.0" && cfg.host !== "::" ? cfg.host : osHostname();
  const discovered = `http://${host}:${port}`;
  return normalizeHiveUrlOrExit(discovered);
}

function normalizeHiveUrlOrExit(input: string): string {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    console.error(`Invalid --hive-url: ${input}`);
    process.exit(2);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    console.error(`--hive-url must be http(s): got ${url.protocol}`);
    process.exit(2);
  }
  return url.toString().replace(/\/$/, "");
}

async function createRemoteBootstrapToken(options: {
  hiveUrl: string;
  adminToken: string;
  beeName: string;
}): Promise<string> {
  const response = await fetch(
    new URL("/api/bootstrap-tokens", ensureTrailingSlash(options.hiveUrl)),
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${options.adminToken}`,
        "content-type": "application/json",
        "x-hiveplane-actor": "hive-cli-provision",
      },
      body: JSON.stringify({ beeName: options.beeName }),
    },
  );
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(
      `bootstrap token request failed (${response.status} ${response.statusText})${detail ? `: ${detail}` : ""}`,
    );
  }
  const body = (await response.json()) as { token?: unknown };
  if (typeof body.token !== "string" || !body.token.startsWith("hp_boot_")) {
    throw new Error("bootstrap token response did not include a valid token");
  }
  return body.token;
}

function buildProvisionRemoteScript(options: {
  hiveUrl: string;
  installUrl: string;
  bootstrapToken: string;
  beeName: string;
  profile: ProvisionProfile;
}): string {
  return `#!/bin/sh
set -eu

log() { printf '[hiveplane provision] %s\\n' "$1"; }

command -v sh >/dev/null 2>&1 || { echo "sh is required" >&2; exit 1; }
command -v curl >/dev/null 2>&1 || { echo "curl is required" >&2; exit 1; }

log "fetching Bee installer"
curl -fsSL ${shellQuote(options.installUrl)} | \\
  HIVEPLANE_HIVE_URL=${shellQuote(options.hiveUrl)} \\
  HIVEPLANE_BOOTSTRAP_TOKEN=${shellQuote(options.bootstrapToken)} \\
  HIVEPLANE_BEE_NAME=${shellQuote(options.beeName)} \\
  HIVEPLANE_NO_START=1 \\
  sh

BEE_BIN="$HOME/.local/bin/bee"
if [ ! -x "$BEE_BIN" ]; then
  echo "bee CLI was not installed at $BEE_BIN" >&2
  exit 1
fi

log "applying policy profile ${options.profile.policyProfile}"
"$BEE_BIN" policy profile ${shellQuote(options.profile.policyProfile)}

log "starting Bee service"
"$BEE_BIN" start

log "checking Bee service status"
"$BEE_BIN" status
`;
}

async function runSshCommand(options: {
  sshBin: string;
  target: string;
  remoteCommand: string;
  stdin?: string;
  json: boolean;
  dryRun?: boolean;
}): Promise<void> {
  const args = [options.target, options.remoteCommand];
  if (options.dryRun) {
    emitProvisionLog(options.json, "info", "ssh.dry-run", "would run SSH command", {
      sshBin: options.sshBin,
      args,
    });
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const child = spawn(options.sshBin, args, {
      stdio: ["pipe", "pipe", "pipe"],
    });
    child.stdout.on("data", (chunk) => process.stdout.write(chunk));
    child.stderr.on("data", (chunk) => process.stderr.write(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`ssh exited with status ${code}`));
      }
    });
    if (options.stdin) child.stdin.end(options.stdin);
    else child.stdin.end();
  });
}

function emitProvisionLog(
  json: boolean,
  level: ProvisionLogLevel,
  stage: string,
  message: string,
  data: Record<string, unknown> = {},
): void {
  if (json) {
    console.log(
      JSON.stringify({
        type: "provision.log",
        level,
        stage,
        message,
        ...data,
      }),
    );
    return;
  }
  const detail = Object.keys(data).length > 0 ? ` ${JSON.stringify(data)}` : "";
  console.log(`[provision:${stage}] ${message}${detail}`);
}

function ensureTrailingSlash(url: string): string {
  return url.endsWith("/") ? url : `${url}/`;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function runJob(parsed: ArgvParseResult): never {
  const [subcommand, id] = parsed.positional;
  switch (subcommand) {
    case "list":
      notImplemented("hive job list", "job listing needs the remote Hive API client wiring.");
    case "show":
      if (!id) {
        console.error("Usage: hive job show <job-id>");
        process.exit(2);
      }
      notImplemented(
        "hive job show",
        "job detail fetching needs the remote Hive API client wiring.",
      );
    case "logs":
      if (!id) {
        console.error("Usage: hive job logs <job-id>");
        process.exit(2);
      }
      notImplemented(
        "hive job logs",
        "job event streaming needs the remote Hive API client wiring.",
      );
    default:
      console.error("Usage: hive job (list|show <job-id>|logs <job-id>)");
      process.exit(2);
  }
}

function runApproval(parsed: ArgvParseResult): never {
  const [subcommand, id] = parsed.positional;
  switch (subcommand) {
    case "list":
      notImplemented(
        "hive approval list",
        "approval listing needs the remote Hive API client wiring.",
      );
    case "approve":
      if (!id) {
        console.error("Usage: hive approval approve <approval-id>");
        process.exit(2);
      }
      notImplemented(
        "hive approval approve",
        "approval resolution needs the remote Hive API client wiring.",
      );
    case "deny":
      if (!id) {
        console.error("Usage: hive approval deny <approval-id>");
        process.exit(2);
      }
      notImplemented(
        "hive approval deny",
        "approval resolution needs the remote Hive API client wiring.",
      );
    default:
      console.error("Usage: hive approval (list|approve <approval-id>|deny <approval-id>)");
      process.exit(2);
  }
}

function notImplemented(command: string, detail: string): never {
  console.error(`${command} is not implemented yet.`);
  console.error(detail);
  process.exit(1);
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
  hive login <url> --token <t>
                             Placeholder for remote Hive auth profile login.
  hive daemon start|status|stop|restart|logs
                             Aliases for local Hive daemon control.
  hive node register         Placeholder for direct node registration.
  hive node provision ssh <user@host>
                             Provision a Bee over SSH using the normal
                             installer, bootstrap token, and policy profile.
  hive job list              Placeholder for job listing.
  hive job show <job-id>     Placeholder for job details.
  hive job logs <job-id>     Placeholder for job event logs.
  hive approval list         Placeholder for approval listing.
  hive approval approve <id> Placeholder for approving a pending action.
  hive approval deny <id>    Placeholder for denying a pending action.
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
  --hive-url <url>           'node provision ssh': URL the new Bee should use
  --profile <id>             'node provision ssh': macos-openclaw,
                             linux-openclaw, server-worker, dev-box, read-only
  --healthcheck-only         'node provision ssh': only verify remote SSH shell
  --dry-run                  'node provision ssh': print actions without
                             minting a token or running remote install
  -f, --follow               'logs' tails the file
`,
  );
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
