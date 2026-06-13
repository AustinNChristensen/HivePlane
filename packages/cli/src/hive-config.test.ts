import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  generateAdminToken,
  getHiveConfigPath,
  readHiveOnDiskConfig,
  writeHiveOnDiskConfig,
} from "./hive-config.js";

let configDir: string;

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), "hp-hive-cfg-"));
});

afterEach(() => {
  rmSync(configDir, { recursive: true, force: true });
});

describe("hive-config", () => {
  it("returns an empty object when no config file exists", () => {
    expect(readHiveOnDiskConfig(configDir)).toEqual({});
  });

  it("round-trips through write + read", () => {
    const written = {
      adminToken: "abc123",
      host: "0.0.0.0",
      port: 9999,
      authRequired: true,
      openBrowser: false,
      incidentNotificationCommand: ["/usr/local/bin/hive-alert", "--target", "+15555550123"],
    };
    const { path } = writeHiveOnDiskConfig(written, configDir);
    expect(path).toBe(getHiveConfigPath(configDir));
    expect(readHiveOnDiskConfig(configDir)).toEqual(written);
  });

  it("strips undefined fields so the file stays tidy", () => {
    // `exactOptionalPropertyTypes` means we can't pass `host: undefined`
    // through the typed shape — but the writer also receives raw inputs (e.g.
    // from `Object.assign`d configs), so cast through `unknown` to exercise
    // that path explicitly.
    writeHiveOnDiskConfig(
      { adminToken: "abc", host: undefined, port: undefined } as unknown as Parameters<
        typeof writeHiveOnDiskConfig
      >[0],
      configDir,
    );
    const raw = readFileSync(getHiveConfigPath(configDir), "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    expect(parsed).toEqual({ adminToken: "abc" });
    expect(parsed).not.toHaveProperty("host");
    expect(parsed).not.toHaveProperty("port");
  });

  it("writes the config file with mode 0600 (admin token is a secret)", () => {
    if (process.platform === "win32") return; // Windows ignores POSIX modes.
    writeHiveOnDiskConfig({ adminToken: "abc" }, configDir);
    const stat = statSync(getHiveConfigPath(configDir));
    // Mask off the type bits, only inspect permission bits.
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it("treats malformed JSON as 'no config' rather than crashing", () => {
    const path = getHiveConfigPath(configDir);
    mkdirSync(configDir, { recursive: true });
    writeFileSync(path, "{ this is not json");
    expect(readHiveOnDiskConfig(configDir)).toEqual({});
  });

  it("generateAdminToken yields URL-safe tokens of meaningful length", () => {
    const a = generateAdminToken();
    const b = generateAdminToken();
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThanOrEqual(20);
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});
