import { execFile } from "node:child_process";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

const cliEntry = join(fileURLToPath(import.meta.url), "..", "hive.ts");

async function runCli(args: string[]) {
  const configDir = mkdtempSync(join(tmpdir(), "hiveplane-hive-cli-test-"));
  return execFileAsync(
    process.execPath,
    ["--import", "tsx", cliEntry, "--config-dir", configDir, ...args],
    {
      env: { ...process.env, HIVEPLANE_CONFIG_DIR: configDir },
    },
  );
}

describe("hive CLI command surface", () => {
  it("documents node, job, approval, daemon, and login commands", async () => {
    const { stdout } = await runCli(["--help"]);

    expect(stdout).toContain("hive login <url> --token <t>");
    expect(stdout).toContain("hive daemon start|status|stop|restart|logs");
    expect(stdout).toContain("hive node provision ssh <user@host>");
    expect(stdout).toContain("hive job show <job-id>");
    expect(stdout).toContain("hive approval approve <id>");
  });

  it("runs the SSH provisioning healthcheck without storing SSH credentials", async () => {
    const fakeSsh = join(mkdtempSync(join(tmpdir(), "hiveplane-fake-ssh-")), "ssh");
    writeFileSync(fakeSsh, "#!/bin/sh\necho fake-ssh:$*\n", { mode: 0o755 });
    chmodSync(fakeSsh, 0o755);

    const { stdout } = await runCli([
      "node",
      "provision",
      "ssh",
      "ops-box",
      "--ssh-bin",
      fakeSsh,
      "--hive-url",
      "http://hive.tailnet.test:4483",
      "--healthcheck-only",
    ]);

    expect(stdout).toContain("[provision:ssh.healthcheck]");
    expect(stdout).toContain("fake-ssh:ops-box");
    expect(stdout).toContain("[provision:complete] remote SSH healthcheck passed");
  });

  it("prints a dry-run provisioning plan with the selected node profile", async () => {
    const { stdout } = await runCli([
      "node",
      "provision",
      "ssh",
      "austin@ops-box",
      "--hive-url",
      "http://hive.tailnet.test:4483",
      "--profile",
      "server-worker",
      "--dry-run",
    ]);

    expect(stdout).toContain("[provision:ssh.dry-run]");
    expect(stdout).toContain("[provision:dry-run] would mint a bootstrap token and run installer");
    expect(stdout).toContain("server-worker");
  });

  it("validates job detail usage before the remote API is implemented", async () => {
    await expect(runCli(["job", "show"])).rejects.toMatchObject({
      code: 2,
      stderr: expect.stringContaining("Usage: hive job show <job-id>"),
    });
  });

  it("parses approval commands and returns a clear not-implemented error", async () => {
    await expect(runCli(["approval", "approve", "apv_123"])).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining("hive approval approve is not implemented yet."),
    });
  });
});
