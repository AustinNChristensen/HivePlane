import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Reset module cache between tests so per-test mocks of node:os work cleanly.
let installBeeService: typeof import("./service.js").installBeeService;
let getBeeServiceStatus: typeof import("./service.js").getBeeServiceStatus;
let getServicePlatform: typeof import("./service.js").getServicePlatform;
let getUnitPath: typeof import("./service.js").getUnitPath;

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
  getBeeServiceStatus = mod.getBeeServiceStatus;
  getServicePlatform = mod.getServicePlatform;
  getUnitPath = mod.getUnitPath;
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

  mkdirSync(join(templateDir, "systemd"), { recursive: true });
  writeFileSync(
    join(templateDir, "systemd", "hiveplane-bee.service.tmpl"),
    `WorkingDirectory=__INSTALL_DIR__\nEnv=PATH=__PATH__\nExec=__PNPM_BIN__ start\nCFG=__CONFIG_DIR__\n`,
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
