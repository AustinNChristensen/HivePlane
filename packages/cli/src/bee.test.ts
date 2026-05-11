import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

const cliEntry = join(fileURLToPath(import.meta.url), "..", "bee.ts");

async function runCli(args: string[], configDir: string) {
  return execFileAsync(
    process.execPath,
    ["--import", "tsx", cliEntry, "--config-dir", configDir, ...args],
    {
      env: { ...process.env, HIVEPLANE_CONFIG_DIR: configDir },
    },
  );
}

function newDir() {
  return mkdtempSync(join(tmpdir(), "hiveplane-cli-test-"));
}

describe("bee CLI", () => {
  it("login writes config.json with the given URL and creates an identity", async () => {
    const dir = newDir();
    const { stdout } = await runCli(["login", "http://hive.example:4483"], dir);

    expect(stdout).toContain("Logged into http://hive.example:4483/");
    expect(stdout).toContain("Bee identity:");

    const config = JSON.parse(readFileSync(join(dir, "config.json"), "utf8")) as {
      hiveUrl?: string;
    };
    expect(config.hiveUrl).toBe("http://hive.example:4483/");

    const identity = JSON.parse(readFileSync(join(dir, "bee-identity.json"), "utf8")) as {
      fingerprint: string;
    };
    expect(identity.fingerprint).toMatch(/^sha256:/);
  });

  it("login with --name persists beeName", async () => {
    const dir = newDir();
    await runCli(["login", "http://hive.example:4483", "--name", "mac-mini"], dir);
    const config = JSON.parse(readFileSync(join(dir, "config.json"), "utf8")) as {
      beeName?: string;
    };
    expect(config.beeName).toBe("mac-mini");
  });

  it("logout clears the Hive URL but keeps beeName + identity", async () => {
    const dir = newDir();
    await runCli(["login", "http://hive.example:4483", "--name", "mac-mini"], dir);
    await runCli(["logout"], dir);

    const config = JSON.parse(readFileSync(join(dir, "config.json"), "utf8")) as {
      hiveUrl?: string;
      beeName?: string;
    };
    expect(config.hiveUrl).toBeUndefined();
    expect(config.beeName).toBe("mac-mini");
  });

  it("status reports unset state and identity-pending message before login", async () => {
    const dir = newDir();
    const { stdout } = await runCli(["status"], dir);

    expect(stdout).toContain("(not set");
    expect(stdout).toContain("(will be generated on first login)");
  });

  it("status reports configured state after login", async () => {
    const dir = newDir();
    await runCli(["login", "http://hive.example:4483"], dir);
    const { stdout } = await runCli(["status"], dir);

    expect(stdout).toContain("Hive URL:      http://hive.example:4483/");
    expect(stdout).toContain("Identity:      sha256:");
  });

  it("rejects non-http URLs", async () => {
    const dir = newDir();
    await expect(runCli(["login", "ftp://hive.example"], dir)).rejects.toMatchObject({
      code: 2,
    });
  });
});
