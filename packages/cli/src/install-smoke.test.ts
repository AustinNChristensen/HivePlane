import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
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
  const cliEntry = join(repoRoot, "packages", "cli", "src", "index.ts");

  it("invokes the CLI via the workspace tsx binary without ERR_MODULE_NOT_FOUND", async () => {
    if (!existsSync(tsxBin)) {
      // pnpm install hasn't run yet — skip rather than fail in clean checkouts.
      return;
    }
    const { stdout, stderr } = await execFileAsync(tsxBin, [cliEntry, "--version"], {
      cwd: repoRoot,
    });
    expect(stderr).not.toMatch(/ERR_MODULE_NOT_FOUND/);
    expect(stderr).not.toMatch(/Cannot find package/);
    expect(stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("can dispatch `selfhost status` (exercises @hiveplane/daemon import path)", async () => {
    if (!existsSync(tsxBin)) return;
    // `selfhost status` reaches into hive-config + service status. It pulls in
    // the daemon-imported helpers (getDefaultHivePlaneConfigDir etc.), so a
    // missing `@hiveplane/daemon` resolution is fatal for this path.
    const { stdout, stderr } = await execFileAsync(tsxBin, [cliEntry, "selfhost", "status"], {
      cwd: repoRoot,
      env: { ...process.env, HIVEPLANE_CONFIG_DIR: "/tmp/hp-smoke-nonexistent" },
    });
    expect(stderr).not.toMatch(/ERR_MODULE_NOT_FOUND/);
    expect(stdout).toMatch(/Config file:/);
  });
});
