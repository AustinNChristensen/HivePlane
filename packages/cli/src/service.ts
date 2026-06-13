import { execFile, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, platform, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type ServicePlatform = "darwin" | "linux";

export type ServiceStatus = {
  platform: ServicePlatform | "unsupported";
  installed: boolean;
  running: boolean;
  unitPath?: string;
  logDir: string;
  /** Last exit code reported by launchctl/systemctl, if any. */
  lastExitCode?: number;
};

export type InstallServiceOptions = {
  /** Absolute path to the HivePlane install dir (where pnpm runs). */
  installDir: string;
  /** Absolute path to pnpm binary. */
  pnpmBin: string;
  /** Absolute path to the directory containing `node` (added to PATH). */
  nodeBinDir: string;
  /** Bee config dir (`~/.hiveplane`). */
  configDir: string;
  /** Where to write logs. Created if missing. */
  logDir?: string;
  /** Override the unit-templates dir. Defaults to `<installDir>/infra/install`. */
  templateDir?: string;
};

/**
 * Internal description of a HivePlane daemon for the launchd/systemctl layer.
 * Used to drive both the Bee daemon and the Hive control plane through the
 * same install/start/stop/status code path.
 */
type DaemonSpec = {
  /** launchd label, e.g. `com.hiveplane.bee` / `com.hiveplane.hive`. */
  launchdLabel: string;
  /** systemd unit filename, e.g. `hiveplane-bee.service`. */
  systemdUnitName: string;
  /** Template basename under `infra/install/launchd`. */
  launchdTemplate: string;
  /** Template basename under `infra/install/systemd`. */
  systemdTemplate: string;
  /** Filename used for the launchd stdout/stderr logs (e.g. `bee` → bee.out.log). */
  logFileBasename: string;
};

const BEE_DAEMON: DaemonSpec = {
  launchdLabel: "com.hiveplane.bee",
  systemdUnitName: "hiveplane-bee.service",
  launchdTemplate: "com.hiveplane.bee.plist.tmpl",
  systemdTemplate: "hiveplane-bee.service.tmpl",
  logFileBasename: "bee",
};

const HIVE_DAEMON: DaemonSpec = {
  launchdLabel: "com.hiveplane.hive",
  systemdUnitName: "hiveplane-hive.service",
  launchdTemplate: "com.hiveplane.hive.plist.tmpl",
  systemdTemplate: "hiveplane-hive.service.tmpl",
  logFileBasename: "hive",
};

const RESCUE_DAEMON: DaemonSpec = {
  launchdLabel: "com.hiveplane.rescue",
  systemdUnitName: "hiveplane-rescue.service",
  launchdTemplate: "com.hiveplane.rescue.plist.tmpl",
  systemdTemplate: "hiveplane-rescue.service.tmpl",
  logFileBasename: "rescue",
};

export function getServicePlatform(): ServicePlatform | "unsupported" {
  const p = platform();
  if (p === "darwin") return "darwin";
  if (p === "linux") return "linux";
  return "unsupported";
}

export function getDefaultLogDir(configDir: string): string {
  return join(configDir, "logs");
}

function unitPathFor(plat: ServicePlatform, spec: DaemonSpec): string {
  if (plat === "darwin") {
    return join(homedir(), "Library", "LaunchAgents", `${spec.launchdLabel}.plist`);
  }
  return join(homedir(), ".config", "systemd", "user", spec.systemdUnitName);
}

export function getUnitPath(plat: ServicePlatform): string {
  // Back-compat: original API resolves the Bee unit path. New callers should
  // prefer `getBeeUnitPath` / `getHiveUnitPath`.
  return unitPathFor(plat, BEE_DAEMON);
}

export function getBeeUnitPath(plat: ServicePlatform): string {
  return unitPathFor(plat, BEE_DAEMON);
}

export function getHiveUnitPath(plat: ServicePlatform): string {
  return unitPathFor(plat, HIVE_DAEMON);
}

export function getRescueUnitPath(plat: ServicePlatform): string {
  return unitPathFor(plat, RESCUE_DAEMON);
}

function defaultTemplateDir(installDir: string): string {
  return join(installDir, "infra", "install");
}

function renderTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/__([A-Z_]+)__/g, (_, key) => {
    const value = vars[key];
    if (value === undefined) {
      throw new Error(`template variable ${key} not provided`);
    }
    return value;
  });
}

function installServiceUnit(
  spec: DaemonSpec,
  options: InstallServiceOptions,
): { platform: ServicePlatform; unitPath: string } {
  const plat = getServicePlatform();
  if (plat === "unsupported") {
    throw new Error(
      `auto-start is not supported on this platform (got ${platform()}). Run the daemon manually instead.`,
    );
  }

  const logDir = options.logDir ?? getDefaultLogDir(options.configDir);
  mkdirSync(logDir, { recursive: true });

  const templateDir = options.templateDir ?? defaultTemplateDir(options.installDir);
  const templateFile =
    plat === "darwin"
      ? join(templateDir, "launchd", spec.launchdTemplate)
      : join(templateDir, "systemd", spec.systemdTemplate);

  if (!existsSync(templateFile)) {
    throw new Error(`unit template missing: ${templateFile}`);
  }

  const template = readFileSync(templateFile, "utf8");
  const rendered = renderTemplate(template, {
    LABEL: spec.launchdLabel,
    PNPM_BIN: options.pnpmBin,
    INSTALL_DIR: options.installDir,
    PATH: `${options.nodeBinDir}:${dirname(options.pnpmBin)}:/usr/local/bin:/usr/bin:/bin`,
    CONFIG_DIR: options.configDir,
    LOG_DIR: logDir,
  });

  const unitPath = unitPathFor(plat, spec);
  mkdirSync(dirname(unitPath), { recursive: true });
  writeFileSync(unitPath, rendered, { mode: 0o644 });

  if (plat === "linux") {
    // systemd needs to reload to see new unit file.
    try {
      execFileSync("systemctl", ["--user", "daemon-reload"], { stdio: "ignore" });
    } catch {
      // best-effort; user may not have systemctl --user available (e.g. WSL1)
    }
  }

  return { platform: plat, unitPath };
}

async function startServiceUnit(spec: DaemonSpec): Promise<void> {
  const plat = getServicePlatform();
  if (plat === "unsupported") {
    throw new Error("auto-start is not supported on this platform");
  }

  if (plat === "darwin") {
    const uid = userInfo().uid;
    const unitPath = unitPathFor(plat, spec);
    if (!existsSync(unitPath)) {
      throw new Error(`unit file missing: ${unitPath}. Run the install step first.`);
    }
    // Idempotent-ish: launchd sometimes returns Bootstrap failed: 5 right after
    // bootout even though an immediate retry succeeds. Treat bootstrap as a
    // short retry loop, then kickstart the loaded label.
    await bootstrapLaunchAgent(uid, spec.launchdLabel, unitPath);
    await kickstartLaunchAgent(uid, spec.launchdLabel);
  } else {
    await execFileAsync("systemctl", ["--user", "enable", "--now", spec.systemdUnitName]);
  }
}

async function stopServiceUnit(spec: DaemonSpec): Promise<void> {
  const plat = getServicePlatform();
  if (plat === "unsupported") return;

  if (plat === "darwin") {
    const uid = userInfo().uid;
    await runIgnoringFamiliarFailures("launchctl", ["bootout", `gui/${uid}/${spec.launchdLabel}`]);
    await waitForLaunchAgentGone(uid, spec.launchdLabel);
  } else {
    await runIgnoringFamiliarFailures("systemctl", [
      "--user",
      "disable",
      "--now",
      spec.systemdUnitName,
    ]);
  }
}

function stopServiceUnitSync(spec: DaemonSpec): void {
  const plat = getServicePlatform();
  if (plat === "darwin") {
    const uid = userInfo().uid;
    try {
      execFileSync("launchctl", ["bootout", `gui/${uid}/${spec.launchdLabel}`], {
        stdio: "ignore",
      });
    } catch {
      // already stopped
    }
  } else if (plat === "linux") {
    try {
      execFileSync("systemctl", ["--user", "disable", "--now", spec.systemdUnitName], {
        stdio: "ignore",
      });
    } catch {
      // already stopped
    }
  }
}

function uninstallServiceUnit(spec: DaemonSpec): { unitRemoved: boolean; unitPath?: string } {
  const plat = getServicePlatform();
  if (plat === "unsupported") return { unitRemoved: false };

  const unitPath = unitPathFor(plat, spec);
  if (!existsSync(unitPath)) {
    return { unitRemoved: false };
  }

  try {
    stopServiceUnitSync(spec);
  } catch {
    // ignore
  }

  unlinkSync(unitPath);

  if (plat === "linux") {
    try {
      execFileSync("systemctl", ["--user", "daemon-reload"], { stdio: "ignore" });
    } catch {
      // best-effort
    }
  }

  return { unitRemoved: true, unitPath };
}

async function getServiceUnitStatus(spec: DaemonSpec, configDir: string): Promise<ServiceStatus> {
  const plat = getServicePlatform();
  if (plat === "unsupported") {
    return {
      platform: "unsupported",
      installed: false,
      running: false,
      logDir: getDefaultLogDir(configDir),
    };
  }

  const unitPath = unitPathFor(plat, spec);
  const installed = existsSync(unitPath);

  let running = false;
  let lastExitCode: number | undefined;

  if (installed) {
    if (plat === "darwin") {
      const uid = userInfo().uid;
      try {
        const { stdout } = await execFileAsync("launchctl", [
          "print",
          `gui/${uid}/${spec.launchdLabel}`,
        ]);
        const stateLine = stdout.match(/state\s*=\s*(\w+)/);
        if (stateLine && stateLine[1] === "running") running = true;
        const exitMatch = stdout.match(/last exit code\s*=\s*(-?\d+)/);
        if (exitMatch && exitMatch[1]) lastExitCode = Number(exitMatch[1]);
      } catch {
        // not loaded
      }
    } else {
      try {
        const { stdout } = await execFileAsync("systemctl", [
          "--user",
          "is-active",
          spec.systemdUnitName,
        ]);
        running = stdout.trim() === "active";
      } catch (error) {
        const stdout = (error as { stdout?: string }).stdout?.toString() ?? "";
        running = stdout.trim() === "active";
      }
    }
  }

  return {
    platform: plat,
    installed,
    running,
    ...(installed ? { unitPath } : {}),
    logDir: getDefaultLogDir(configDir),
    ...(lastExitCode !== undefined ? { lastExitCode } : {}),
  };
}

// --- Public Bee API (kept stable so existing CLI imports don't break) ----

export function installBeeService(options: InstallServiceOptions): {
  platform: ServicePlatform;
  unitPath: string;
} {
  return installServiceUnit(BEE_DAEMON, options);
}

export function uninstallBeeService(): { unitRemoved: boolean; unitPath?: string } {
  return uninstallServiceUnit(BEE_DAEMON);
}

export async function startBeeService(): Promise<void> {
  await startServiceUnit(BEE_DAEMON);
}

export async function stopBeeService(): Promise<void> {
  await stopServiceUnit(BEE_DAEMON);
}

export async function restartBeeService(): Promise<void> {
  await stopBeeService();
  await startBeeService();
}

export async function getBeeServiceStatus(configDir: string): Promise<ServiceStatus> {
  return getServiceUnitStatus(BEE_DAEMON, configDir);
}

// --- Public Rescue API -------------------------------------------------------

export function installRescueService(options: InstallServiceOptions): {
  platform: ServicePlatform;
  unitPath: string;
} {
  return installServiceUnit(RESCUE_DAEMON, options);
}

export function uninstallRescueService(): { unitRemoved: boolean; unitPath?: string } {
  return uninstallServiceUnit(RESCUE_DAEMON);
}

export async function startRescueService(): Promise<void> {
  await startServiceUnit(RESCUE_DAEMON);
}

export async function stopRescueService(): Promise<void> {
  await stopServiceUnit(RESCUE_DAEMON);
}

export async function restartRescueService(): Promise<void> {
  await stopRescueService();
  await startRescueService();
}

export async function getRescueServiceStatus(configDir: string): Promise<ServiceStatus> {
  return getServiceUnitStatus(RESCUE_DAEMON, configDir);
}

// --- Public Hive API ---------------------------------------------------------

export function installHiveService(options: InstallServiceOptions): {
  platform: ServicePlatform;
  unitPath: string;
} {
  return installServiceUnit(HIVE_DAEMON, options);
}

export function uninstallHiveService(): { unitRemoved: boolean; unitPath?: string } {
  return uninstallServiceUnit(HIVE_DAEMON);
}

export async function startHiveService(): Promise<void> {
  await startServiceUnit(HIVE_DAEMON);
}

export async function stopHiveService(): Promise<void> {
  await stopServiceUnit(HIVE_DAEMON);
}

export async function restartHiveService(): Promise<void> {
  await stopHiveService();
  await startHiveService();
}

export async function getHiveServiceStatus(configDir: string): Promise<ServiceStatus> {
  return getServiceUnitStatus(HIVE_DAEMON, configDir);
}

/**
 * Returns the launchd stdout/stderr log paths for the named daemon, regardless
 * of whether the unit is currently installed. The Bee/Hive write to
 * `<logDir>/<daemon>.out.log` and `<logDir>/<daemon>.err.log` respectively.
 */
export function getDaemonLogFiles(
  daemon: "bee" | "hive" | "rescue",
  configDir: string,
): { stdout: string; stderr: string } {
  const spec = daemon === "bee" ? BEE_DAEMON : daemon === "hive" ? HIVE_DAEMON : RESCUE_DAEMON;
  const dir = getDefaultLogDir(configDir);
  return {
    stdout: join(dir, `${spec.logFileBasename}.out.log`),
    stderr: join(dir, `${spec.logFileBasename}.err.log`),
  };
}

/** Re-exported for tests; the names are stable. */
export const BEE_LAUNCHD_LABEL = BEE_DAEMON.launchdLabel;
export const BEE_SYSTEMD_UNIT_NAME = BEE_DAEMON.systemdUnitName;
export const HIVE_LAUNCHD_LABEL = HIVE_DAEMON.launchdLabel;
export const HIVE_SYSTEMD_UNIT_NAME = HIVE_DAEMON.systemdUnitName;
export const RESCUE_LAUNCHD_LABEL = RESCUE_DAEMON.launchdLabel;
export const RESCUE_SYSTEMD_UNIT_NAME = RESCUE_DAEMON.systemdUnitName;

async function runIgnoringFamiliarFailures(cmd: string, args: string[]): Promise<void> {
  try {
    await execFileAsync(cmd, args);
  } catch (error) {
    // launchctl returns non-zero for "already loaded" / "not loaded" — those
    // are fine to ignore. Re-throw only if stderr looks like a real failure.
    const stderr = (error as { stderr?: string }).stderr?.toString() ?? "";
    const benign = /already|not loaded|not currently|no such process/i.test(stderr);
    if (!benign) {
      throw error;
    }
  }
}

async function bootstrapLaunchAgent(
  uid: number,
  label: string,
  unitPath: string,
): Promise<"loaded" | "already_loaded"> {
  const target = `gui/${uid}`;
  let lastError: unknown;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await execFileAsync("launchctl", ["bootstrap", target, unitPath]);
      return "loaded";
    } catch (error) {
      lastError = error;
      const stderr = (error as { stderr?: string }).stderr?.toString() ?? "";
      if (/already/i.test(stderr) || (await launchAgentExists(uid, label))) {
        return "already_loaded";
      }
      if (attempt < 2) await delay(250 * (attempt + 1));
    }
  }

  throw lastError;
}

async function launchAgentExists(uid: number, label: string): Promise<boolean> {
  try {
    await execFileAsync("launchctl", ["print", `gui/${uid}/${label}`]);
    return true;
  } catch {
    return false;
  }
}

async function waitForLaunchAgentGone(uid: number, label: string): Promise<void> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    if (!(await launchAgentExists(uid, label))) return;
    await delay(150);
  }
}

async function kickstartLaunchAgent(uid: number, label: string): Promise<void> {
  const target = `gui/${uid}/${label}`;
  let lastError: unknown;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await execFileAsync("launchctl", ["kickstart", "-k", target]);
      return;
    } catch (error) {
      lastError = error;
      if (attempt < 2) await delay(250 * (attempt + 1));
    }
  }

  throw lastError;
}
