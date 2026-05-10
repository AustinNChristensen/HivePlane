import { execFile, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, platform, userInfo } from "node:os";
import { dirname, join } from "node:path";
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

const LAUNCHD_LABEL = "com.hiveplane.bee";
const SYSTEMD_UNIT_NAME = "hiveplane-bee.service";

export function getServicePlatform(): ServicePlatform | "unsupported" {
  const p = platform();
  if (p === "darwin") return "darwin";
  if (p === "linux") return "linux";
  return "unsupported";
}

export function getDefaultLogDir(configDir: string): string {
  return join(configDir, "logs");
}

export function getUnitPath(plat: ServicePlatform): string {
  if (plat === "darwin") {
    return join(homedir(), "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`);
  }
  return join(homedir(), ".config", "systemd", "user", SYSTEMD_UNIT_NAME);
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

export function installBeeService(options: InstallServiceOptions): {
  platform: ServicePlatform;
  unitPath: string;
} {
  const plat = getServicePlatform();
  if (plat === "unsupported") {
    throw new Error(
      `auto-start is not supported on this platform (got ${platform()}). Run \`hive start\` manually.`,
    );
  }

  const logDir = options.logDir ?? getDefaultLogDir(options.configDir);
  mkdirSync(logDir, { recursive: true });

  const templateDir = options.templateDir ?? defaultTemplateDir(options.installDir);
  const templateFile =
    plat === "darwin"
      ? join(templateDir, "launchd", "com.hiveplane.bee.plist.tmpl")
      : join(templateDir, "systemd", "hiveplane-bee.service.tmpl");

  if (!existsSync(templateFile)) {
    throw new Error(`unit template missing: ${templateFile}`);
  }

  const template = readFileSync(templateFile, "utf8");
  const rendered = renderTemplate(template, {
    LABEL: LAUNCHD_LABEL,
    PNPM_BIN: options.pnpmBin,
    INSTALL_DIR: options.installDir,
    PATH: `${options.nodeBinDir}:${dirname(options.pnpmBin)}:/usr/local/bin:/usr/bin:/bin`,
    CONFIG_DIR: options.configDir,
    LOG_DIR: logDir,
  });

  const unitPath = getUnitPath(plat);
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

export function uninstallBeeService(): { unitRemoved: boolean; unitPath?: string } {
  const plat = getServicePlatform();
  if (plat === "unsupported") return { unitRemoved: false };

  const unitPath = getUnitPath(plat);
  if (!existsSync(unitPath)) {
    return { unitRemoved: false };
  }

  // Stop first if running
  try {
    stopBeeServiceSync();
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

export async function startBeeService(): Promise<void> {
  const plat = getServicePlatform();
  if (plat === "unsupported") {
    throw new Error("auto-start is not supported on this platform");
  }

  if (plat === "darwin") {
    const uid = userInfo().uid;
    const unitPath = getUnitPath(plat);
    if (!existsSync(unitPath)) {
      throw new Error(`unit file missing: ${unitPath}. Run \`hive enable\` first.`);
    }
    // Idempotent: bootstrap may fail with code 17 (already loaded), kickstart starts it.
    await runIgnoringFamiliarFailures("launchctl", ["bootstrap", `gui/${uid}`, unitPath]);
    await runIgnoringFamiliarFailures("launchctl", [
      "kickstart",
      "-k",
      `gui/${uid}/${LAUNCHD_LABEL}`,
    ]);
  } else {
    await execFileAsync("systemctl", ["--user", "enable", "--now", SYSTEMD_UNIT_NAME]);
  }
}

export async function stopBeeService(): Promise<void> {
  const plat = getServicePlatform();
  if (plat === "unsupported") return;

  if (plat === "darwin") {
    const uid = userInfo().uid;
    await runIgnoringFamiliarFailures("launchctl", ["bootout", `gui/${uid}/${LAUNCHD_LABEL}`]);
  } else {
    await runIgnoringFamiliarFailures("systemctl", [
      "--user",
      "disable",
      "--now",
      SYSTEMD_UNIT_NAME,
    ]);
  }
}

function stopBeeServiceSync(): void {
  const plat = getServicePlatform();
  if (plat === "darwin") {
    const uid = userInfo().uid;
    try {
      execFileSync("launchctl", ["bootout", `gui/${uid}/${LAUNCHD_LABEL}`], { stdio: "ignore" });
    } catch {
      // already stopped
    }
  } else if (plat === "linux") {
    try {
      execFileSync("systemctl", ["--user", "disable", "--now", SYSTEMD_UNIT_NAME], {
        stdio: "ignore",
      });
    } catch {
      // already stopped
    }
  }
}

export async function restartBeeService(): Promise<void> {
  await stopBeeService();
  await startBeeService();
}

export async function getBeeServiceStatus(configDir: string): Promise<ServiceStatus> {
  const plat = getServicePlatform();
  if (plat === "unsupported") {
    return {
      platform: "unsupported",
      installed: false,
      running: false,
      logDir: getDefaultLogDir(configDir),
    };
  }

  const unitPath = getUnitPath(plat);
  const installed = existsSync(unitPath);

  let running = false;
  let lastExitCode: number | undefined;

  if (installed) {
    if (plat === "darwin") {
      const uid = userInfo().uid;
      try {
        const { stdout } = await execFileAsync("launchctl", [
          "print",
          `gui/${uid}/${LAUNCHD_LABEL}`,
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
          SYSTEMD_UNIT_NAME,
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

async function runIgnoringFamiliarFailures(cmd: string, args: string[]): Promise<void> {
  try {
    await execFileAsync(cmd, args);
  } catch (error) {
    // launchctl returns non-zero for "already loaded" / "not loaded" — those
    // are fine to ignore. Re-throw only if stderr looks like a real failure.
    const stderr = (error as { stderr?: string }).stderr?.toString() ?? "";
    const benign = /already|not loaded|not currently/i.test(stderr);
    if (!benign) {
      throw error;
    }
  }
}
