import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * Write-side helpers for the Hive on-disk config file. The runtime
 * (`apps/web/src/config.ts`) is the read-side and validates with zod; this
 * file just owns the path + shape so the `hive selfhost` subcommands can
 * produce a config without the CLI taking a runtime dependency on the web
 * app.
 *
 * Keep the shape in sync with `HiveOnDiskConfigSchema` in
 * `apps/web/src/config.ts`.
 */
export type HiveOnDiskConfig = {
  adminToken?: string;
  host?: string;
  port?: number;
  authRequired?: boolean;
  openBrowser?: boolean;
  incidentNotificationWebhookUrl?: string;
  incidentNotificationCommand?: string[];
};

export const HIVE_CONFIG_FILENAME = "hive-config.json";

export function getDefaultHivePlaneConfigDirForHive(): string {
  return process.env.HIVEPLANE_CONFIG_DIR ?? join(homedir(), ".hiveplane");
}

export function getHiveConfigPath(configDir = getDefaultHivePlaneConfigDirForHive()): string {
  return join(configDir, HIVE_CONFIG_FILENAME);
}

export function readHiveOnDiskConfig(
  configDir = getDefaultHivePlaneConfigDirForHive(),
): HiveOnDiskConfig {
  const path = getHiveConfigPath(configDir);
  if (!existsSync(path)) return {};
  try {
    const raw = readFileSync(path, "utf8");
    if (!raw.trim()) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as HiveOnDiskConfig;
    }
    return {};
  } catch {
    return {};
  }
}

export function writeHiveOnDiskConfig(
  config: HiveOnDiskConfig,
  configDir = getDefaultHivePlaneConfigDirForHive(),
): { path: string } {
  const path = getHiveConfigPath(configDir);
  mkdirSync(dirname(path), { recursive: true });
  // Strip undefined fields so we don't leave noisy nulls in the file.
  const clean: HiveOnDiskConfig = {};
  for (const [k, v] of Object.entries(config)) {
    if (v !== undefined) (clean as Record<string, unknown>)[k] = v;
  }
  writeFileSync(path, `${JSON.stringify(clean, null, 2)}\n`, { mode: 0o600 });
  // `mode` only applies on file creation; chmod after the write so re-saves
  // don't loosen perms back to whatever umask the user has configured.
  try {
    chmodSync(path, 0o600);
  } catch {
    // ignore — Windows doesn't honor POSIX mode bits.
  }
  return { path };
}

/**
 * Generate a fresh admin bearer token. 32 base64url characters from a CSPRNG —
 * matches the entropy budget of the existing `HIVEPLANE_ADMIN_TOKEN` examples.
 */
export function generateAdminToken(): string {
  return randomBytes(24).toString("base64url");
}
