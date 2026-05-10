import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  clearHiveUrl,
  getHivePlaneConfigPaths,
  readHivePlaneConfig,
  writeHivePlaneConfig,
} from "./config.js";

function newConfigDir() {
  return mkdtempSync(join(tmpdir(), "hiveplane-config-test-"));
}

describe("config file", () => {
  it("returns empty when missing", () => {
    const dir = newConfigDir();
    expect(readHivePlaneConfig(dir)).toEqual({});
  });

  it("writes and reads hive url", () => {
    const dir = newConfigDir();
    writeHivePlaneConfig({ hiveUrl: "https://hive.example/" }, dir);

    const config = readHivePlaneConfig(dir);
    expect(config.hiveUrl).toBe("https://hive.example/");

    const paths = getHivePlaneConfigPaths(dir);
    const raw = readFileSync(paths.configPath, "utf8");
    expect(raw).toContain("https://hive.example/");
  });

  it("merges new fields on write", () => {
    const dir = newConfigDir();
    writeHivePlaneConfig({ hiveUrl: "https://hive.example/" }, dir);
    writeHivePlaneConfig({ beeName: "mac-mini" }, dir);

    const config = readHivePlaneConfig(dir);
    expect(config).toEqual({
      hiveUrl: "https://hive.example/",
      beeName: "mac-mini",
    });
  });

  it("clearHiveUrl drops only the hiveUrl", () => {
    const dir = newConfigDir();
    writeHivePlaneConfig({ hiveUrl: "https://hive.example/", beeName: "mac-mini" }, dir);
    clearHiveUrl(dir);

    const config = readHivePlaneConfig(dir);
    expect(config.hiveUrl).toBeUndefined();
    expect(config.beeName).toBe("mac-mini");
  });
});
