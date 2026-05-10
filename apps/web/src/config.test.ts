import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getHiveConfigPath, readHiveOnDiskConfig, writeHiveOnDiskConfig } from "./config.js";

let configDir: string;
// `readHiveOnDiskConfig` warns on malformed input (intentional — operators
// hand-edit this file). The two negative-path tests below trip that warn on
// purpose; silencing it keeps test output readable without hiding real
// failures from non-test code paths.
let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), "hp-cfg-"));
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  warnSpy.mockRestore();
  rmSync(configDir, { recursive: true, force: true });
});

describe("HiveOnDiskConfig", () => {
  it("returns {} when the file is missing", () => {
    expect(readHiveOnDiskConfig(configDir)).toEqual({});
  });

  it("round-trips a fully-populated config", () => {
    const config = {
      adminToken: "secret",
      host: "0.0.0.0",
      port: 4483,
      authRequired: true,
      openBrowser: false,
    };
    writeHiveOnDiskConfig(config, configDir);
    expect(readHiveOnDiskConfig(configDir)).toEqual(config);
  });

  it("rejects writes that don't match the schema", () => {
    expect(() =>
      writeHiveOnDiskConfig(
        // @ts-expect-error — intentionally malformed, validating runtime check.
        { port: "not-a-number" },
        configDir,
      ),
    ).toThrow();
  });

  it("falls back to {} when the file contains malformed JSON", () => {
    writeFileSync(getHiveConfigPath(configDir), "{ not valid");
    expect(readHiveOnDiskConfig(configDir)).toEqual({});
  });

  it("falls back to {} when the JSON is shaped wrong (e.g. negative port)", () => {
    writeFileSync(getHiveConfigPath(configDir), JSON.stringify({ port: -1 }));
    expect(readHiveOnDiskConfig(configDir)).toEqual({});
  });
});
