import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

/**
 * Repro-style smoke test for the v0.0.1 install bug:
 *
 *   $ ./node_modules/.bin/tsx packages/cli/src/index.ts --version
 *   Error: Cannot find package '/.../packages/cli/node_modules/@hiveplane/daemon/dist/index.js'
 *
 * The cause was that `packages/daemon/package.json` had `"main": "dist/index.js"`
 * but no `"exports"` block, so a fresh install (where nothing built `dist/`)
 * couldn't resolve `import "@hiveplane/daemon"` from the CLI. The fix was to
 * add `"exports": { ".": "./src/index.ts" }` to the daemon package, mirroring
 * what `@hiveplane/protocol` already does.
 *
 * The existing CLI tests use `node --import tsx` which has slightly different
 * resolution semantics from the `tsx` binary the install shim invokes — that
 * gap is what let v0.0.1 ship broken. This test invokes tsx the same way the
 * shim does, against the workspace's actual `node_modules`, so any future
 * regression on package-exports / resolution shows up here.
 */
describe("install-path smoke test", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  // packages/cli/src/install-smoke.test.ts → repo root
  const repoRoot = join(here, "..", "..", "..");
  const tsxBin = join(repoRoot, "node_modules", ".bin", "tsx");
  const hiveEntry = join(repoRoot, "packages", "cli", "src", "hive.ts");
  const beeEntry = join(repoRoot, "packages", "cli", "src", "bee.ts");
  const beeInstallScript = join(repoRoot, "infra", "install", "bee.sh");

  it("hive --version runs through the install shim path", async () => {
    if (!existsSync(tsxBin)) return;
    const { stdout, stderr } = await execFileAsync(tsxBin, [hiveEntry, "--version"], {
      cwd: repoRoot,
    });
    expect(stderr).not.toMatch(/ERR_MODULE_NOT_FOUND/);
    expect(stderr).not.toMatch(/Cannot find package/);
    expect(stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("bee --version runs through the install shim path", async () => {
    if (!existsSync(tsxBin)) return;
    const { stdout, stderr } = await execFileAsync(tsxBin, [beeEntry, "--version"], {
      cwd: repoRoot,
    });
    expect(stderr).not.toMatch(/ERR_MODULE_NOT_FOUND/);
    expect(stderr).not.toMatch(/Cannot find package/);
    expect(stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("hive status (exercises @hiveplane/daemon import on the Hive entry)", async () => {
    if (!existsSync(tsxBin)) return;
    // `hive status` pulls in the daemon-imported helpers
    // (getDefaultHivePlaneConfigDir etc.); a missing `@hiveplane/daemon`
    // resolution would be fatal for this path.
    const { stdout, stderr } = await execFileAsync(tsxBin, [hiveEntry, "status"], {
      cwd: repoRoot,
      env: { ...process.env, HIVEPLANE_CONFIG_DIR: "/tmp/hp-smoke-nonexistent" },
    });
    expect(stderr).not.toMatch(/ERR_MODULE_NOT_FOUND/);
    expect(stdout).toMatch(/Config file:/);
  });

  it("bee status (exercises @hiveplane/daemon import on the Bee entry)", async () => {
    if (!existsSync(tsxBin)) return;
    const { stdout, stderr } = await execFileAsync(tsxBin, [beeEntry, "status"], {
      cwd: repoRoot,
      env: { ...process.env, HIVEPLANE_CONFIG_DIR: "/tmp/hp-smoke-nonexistent" },
    });
    expect(stderr).not.toMatch(/ERR_MODULE_NOT_FOUND/);
    expect(stdout).toMatch(/Hive URL:/);
  });

  it("bee.sh has clear fresh-machine prereqs and one-command pairing hooks", () => {
    const script = readFileSync(beeInstallScript, "utf8");
    expect(script).toContain("Node 20+ is required");
    expect(script).toContain("git is required");
    expect(script).toContain("pnpm not found, enabling via corepack");
    expect(script).toContain("HIVEPLANE_HIVE_URL is required for one-command pairing");
    expect(script).toContain("HIVEPLANE_PAIRING_KEY or HIVEPLANE_BOOTSTRAP_TOKEN is required");
    expect(script).toContain("bee start                 # auto-installs launchd/systemd unit");
  });
});
