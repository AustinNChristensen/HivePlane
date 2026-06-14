import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Reset module cache between tests so per-test mocks of node:os work cleanly.
let installBeeService: typeof import("./service.js").installBeeService;
let installHiveService: typeof import("./service.js").installHiveService;
let installRescueService: typeof import("./service.js").installRescueService;
let getBeeServiceStatus: typeof import("./service.js").getBeeServiceStatus;
let getHiveServiceStatus: typeof import("./service.js").getHiveServiceStatus;
let getRescueServiceStatus: typeof import("./service.js").getRescueServiceStatus;
let getServicePlatform: typeof import("./service.js").getServicePlatform;
let getUnitPath: typeof import("./service.js").getUnitPath;
let getHiveUnitPath: typeof import("./service.js").getHiveUnitPath;
let getRescueUnitPath: typeof import("./service.js").getRescueUnitPath;
let getDaemonLogFiles: typeof import("./service.js").getDaemonLogFiles;

async function loadServiceWithPlatform(plat: NodeJS.Platform, fakeHome: string) {
  vi.resetModules();
  vi.doMock("node:os", async () => {
    const actual = await vi.importActual<typeof import("node:os")>("node:os");
    return {
      ...actual,
      platform: () => plat,
      homedir: () => fakeHome,
    };
  });
  const mod = await import("./service.js");
  installBeeService = mod.installBeeService;
  installHiveService = mod.installHiveService;
  installRescueService = mod.installRescueService;
  getBeeServiceStatus = mod.getBeeServiceStatus;
  getHiveServiceStatus = mod.getHiveServiceStatus;
  getRescueServiceStatus = mod.getRescueServiceStatus;
  getServicePlatform = mod.getServicePlatform;
  getUnitPath = mod.getUnitPath;
  getHiveUnitPath = mod.getHiveUnitPath;
  getRescueUnitPath = mod.getRescueUnitPath;
  getDaemonLogFiles = mod.getDaemonLogFiles;
}

let homeDir: string;
let installDir: string;
let configDir: string;
let templateDir: string;

beforeEach(() => {
  homeDir = mkdtempSync(join(tmpdir(), "hp-home-"));
  installDir = mkdtempSync(join(tmpdir(), "hp-install-"));
  configDir = mkdtempSync(join(tmpdir(), "hp-config-"));
  templateDir = mkdtempSync(join(tmpdir(), "hp-tmpl-"));

  mkdirSync(join(templateDir, "launchd"), { recursive: true });
  writeFileSync(
    join(templateDir, "launchd", "com.hiveplane.bee.plist.tmpl"),
    `LABEL=__LABEL__\nPNPM=__PNPM_BIN__\nWD=__INSTALL_DIR__\nPATH=__PATH__\nCFG=__CONFIG_DIR__\nLOG=__LOG_DIR__\n`,
  );
  writeFileSync(
    join(templateDir, "launchd", "com.hiveplane.hive.plist.tmpl"),
    `LABEL=__LABEL__\nPNPM=__PNPM_BIN__\nWD=__INSTALL_DIR__\nPATH=__PATH__\nCFG=__CONFIG_DIR__\nLOG=__LOG_DIR__\n`,
  );
  writeFileSync(
    join(templateDir, "launchd", "com.hiveplane.rescue.plist.tmpl"),
    `LABEL=__LABEL__\nPNPM=__PNPM_BIN__\nWD=__INSTALL_DIR__\nPATH=__PATH__\nCFG=__CONFIG_DIR__\nLOG=__LOG_DIR__\n`,
  );

  mkdirSync(join(templateDir, "systemd"), { recursive: true });
  writeFileSync(
    join(templateDir, "systemd", "hiveplane-bee.service.tmpl"),
    `WorkingDirectory=__INSTALL_DIR__\nEnv=PATH=__PATH__\nExec=__PNPM_BIN__ start\nCFG=__CONFIG_DIR__\n`,
  );
  writeFileSync(
    join(templateDir, "systemd", "hiveplane-hive.service.tmpl"),
    `WorkingDirectory=__INSTALL_DIR__\nEnv=PATH=__PATH__\nExec=__PNPM_BIN__ web start\nCFG=__CONFIG_DIR__\n`,
  );
  writeFileSync(
    join(templateDir, "systemd", "hiveplane-rescue.service.tmpl"),
    `WorkingDirectory=__INSTALL_DIR__\nEnv=PATH=__PATH__\nExec=__PNPM_BIN__ rescue\nCFG=__CONFIG_DIR__\n`,
  );
});

afterEach(() => {
  rmSync(homeDir, { recursive: true, force: true });
  rmSync(installDir, { recursive: true, force: true });
  rmSync(configDir, { recursive: true, force: true });
  rmSync(templateDir, { recursive: true, force: true });
  vi.doUnmock("node:os");
});

describe("getServicePlatform", () => {
  it("recognizes darwin and linux, returns unsupported otherwise", async () => {
    await loadServiceWithPlatform("darwin", homeDir);
    expect(getServicePlatform()).toBe("darwin");

    await loadServiceWithPlatform("linux", homeDir);
    expect(getServicePlatform()).toBe("linux");

    await loadServiceWithPlatform("win32", homeDir);
    expect(getServicePlatform()).toBe("unsupported");
  });
});

describe("installBeeService — darwin", () => {
  it("renders the launchd plist with the expected substitutions", async () => {
    await loadServiceWithPlatform("darwin", homeDir);

    const result = installBeeService({
      installDir,
      pnpmBin: "/usr/local/bin/pnpm",
      nodeBinDir: "/opt/node/bin",
      configDir,
      templateDir,
    });

    expect(result.platform).toBe("darwin");
    expect(result.unitPath).toBe(join(homeDir, "Library/LaunchAgents/com.hiveplane.bee.plist"));

    const contents = readFileSync(result.unitPath, "utf8");
    expect(contents).toContain("LABEL=com.hiveplane.bee");
    expect(contents).toContain("PNPM=/usr/local/bin/pnpm");
    expect(contents).toContain(`WD=${installDir}`);
    expect(contents).toContain("PATH=/opt/node/bin:/usr/local/bin");
    expect(contents).toContain(`CFG=${configDir}`);
    expect(contents).toContain(`LOG=${join(configDir, "logs")}`);
  });

  it("getUnitPath points into ~/Library/LaunchAgents", async () => {
    await loadServiceWithPlatform("darwin", homeDir);
    expect(getUnitPath("darwin")).toBe(
      join(homeDir, "Library/LaunchAgents/com.hiveplane.bee.plist"),
    );
  });
});

describe("installBeeService — linux", () => {
  it("renders the systemd unit with the expected substitutions", async () => {
    await loadServiceWithPlatform("linux", homeDir);

    const result = installBeeService({
      installDir,
      pnpmBin: "/usr/bin/pnpm",
      nodeBinDir: "/usr/bin",
      configDir,
      templateDir,
    });

    expect(result.platform).toBe("linux");
    expect(result.unitPath).toBe(join(homeDir, ".config/systemd/user/hiveplane-bee.service"));

    const contents = readFileSync(result.unitPath, "utf8");
    expect(contents).toContain(`WorkingDirectory=${installDir}`);
    expect(contents).toContain("Exec=/usr/bin/pnpm start");
    expect(contents).toContain(`CFG=${configDir}`);
  });
});

describe("getBeeServiceStatus", () => {
  it("reports not installed when no unit file exists", async () => {
    await loadServiceWithPlatform("darwin", homeDir);
    const status = await getBeeServiceStatus(configDir);
    expect(status.installed).toBe(false);
    expect(status.running).toBe(false);
    expect(status.platform).toBe("darwin");
    expect(status.logDir).toBe(join(configDir, "logs"));
  });

  it("reports unsupported on non-darwin/linux", async () => {
    await loadServiceWithPlatform("win32", homeDir);
    const status = await getBeeServiceStatus(configDir);
    expect(status.platform).toBe("unsupported");
    expect(status.installed).toBe(false);
  });
});

describe("installHiveService — darwin", () => {
  it("renders the Hive launchd plist into a different unit file than the Bee", async () => {
    await loadServiceWithPlatform("darwin", homeDir);

    const result = installHiveService({
      installDir,
      pnpmBin: "/usr/local/bin/pnpm",
      nodeBinDir: "/opt/node/bin",
      configDir,
      templateDir,
    });

    expect(result.platform).toBe("darwin");
    expect(result.unitPath).toBe(join(homeDir, "Library/LaunchAgents/com.hiveplane.hive.plist"));
    // Different label than the Bee — the two daemons can co-exist on one
    // machine without colliding (e.g. for end-to-end testing).
    expect(getHiveUnitPath("darwin")).not.toBe(
      join(homeDir, "Library/LaunchAgents/com.hiveplane.bee.plist"),
    );

    const contents = readFileSync(result.unitPath, "utf8");
    expect(contents).toContain("LABEL=com.hiveplane.hive");
    expect(contents).toContain(`WD=${installDir}`);
    expect(contents).toContain(`CFG=${configDir}`);
  });
});

describe("installHiveService — linux", () => {
  it("renders the Hive systemd unit at the expected path", async () => {
    await loadServiceWithPlatform("linux", homeDir);

    const result = installHiveService({
      installDir,
      pnpmBin: "/usr/bin/pnpm",
      nodeBinDir: "/usr/bin",
      configDir,
      templateDir,
    });

    expect(result.platform).toBe("linux");
    expect(result.unitPath).toBe(join(homeDir, ".config/systemd/user/hiveplane-hive.service"));

    const contents = readFileSync(result.unitPath, "utf8");
    expect(contents).toContain(`WorkingDirectory=${installDir}`);
    expect(contents).toContain("Exec=/usr/bin/pnpm web start");
  });
});

describe("getHiveServiceStatus", () => {
  it("reports not installed when no unit file exists", async () => {
    await loadServiceWithPlatform("darwin", homeDir);
    const status = await getHiveServiceStatus(configDir);
    expect(status.installed).toBe(false);
    expect(status.running).toBe(false);
    expect(status.platform).toBe("darwin");
    expect(status.logDir).toBe(join(configDir, "logs"));
  });

  it("flips to installed once the Hive unit is on disk, without affecting Bee status", async () => {
    await loadServiceWithPlatform("darwin", homeDir);

    installHiveService({
      installDir,
      pnpmBin: "/usr/local/bin/pnpm",
      nodeBinDir: "/opt/node/bin",
      configDir,
      templateDir,
    });

    const hiveStatus = await getHiveServiceStatus(configDir);
    expect(hiveStatus.installed).toBe(true);
    expect(hiveStatus.unitPath).toBe(getHiveUnitPath("darwin"));

    // Bee status must remain "not installed" — the two daemons keep separate
    // unit files and shouldn't be confused with each other.
    const beeStatus = await getBeeServiceStatus(configDir);
    expect(beeStatus.installed).toBe(false);
  });
});

describe("installRescueService", () => {
  it("renders a separate launchd unit for the Rescue Agent", async () => {
    await loadServiceWithPlatform("darwin", homeDir);

    const result = installRescueService({
      installDir,
      pnpmBin: "/usr/local/bin/pnpm",
      nodeBinDir: "/opt/node/bin",
      configDir,
      templateDir,
    });

    expect(result.platform).toBe("darwin");
    expect(result.unitPath).toBe(join(homeDir, "Library/LaunchAgents/com.hiveplane.rescue.plist"));
    expect(getRescueUnitPath("darwin")).toBe(result.unitPath);
    expect(readFileSync(result.unitPath, "utf8")).toContain("LABEL=com.hiveplane.rescue");
  });

  it("reports Rescue installed independently from Bee", async () => {
    await loadServiceWithPlatform("linux", homeDir);

    installRescueService({
      installDir,
      pnpmBin: "/usr/bin/pnpm",
      nodeBinDir: "/usr/bin",
      configDir,
      templateDir,
    });

    const rescueStatus = await getRescueServiceStatus(configDir);
    expect(rescueStatus.installed).toBe(true);
    expect(rescueStatus.unitPath).toBe(
      join(homeDir, ".config/systemd/user/hiveplane-rescue.service"),
    );
    expect((await getBeeServiceStatus(configDir)).installed).toBe(false);
  });
});

describe("getDaemonLogFiles", () => {
  it("returns daemon-specific log file paths under <configDir>/logs", async () => {
    await loadServiceWithPlatform("darwin", homeDir);
    const bee = getDaemonLogFiles("bee", configDir);
    const hive = getDaemonLogFiles("hive", configDir);
    const rescue = getDaemonLogFiles("rescue", configDir);
    expect(bee.stdout).toBe(join(configDir, "logs", "bee.out.log"));
    expect(bee.stderr).toBe(join(configDir, "logs", "bee.err.log"));
    expect(hive.stdout).toBe(join(configDir, "logs", "hive.out.log"));
    expect(hive.stderr).toBe(join(configDir, "logs", "hive.err.log"));
    expect(rescue.stdout).toBe(join(configDir, "logs", "rescue.out.log"));
    expect(rescue.stderr).toBe(join(configDir, "logs", "rescue.err.log"));
  });
});
