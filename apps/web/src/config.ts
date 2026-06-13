import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";

/**
 * Persistent on-disk config for the Hive control plane. Written by
 * `hive selfhost init` (and by `hive.sh` on first install) so that a
 * service-managed Hive doesn't have to embed secrets in its launchd plist /
 * systemd unit file.
 *
 * Lives at `<configDir>/hive-config.json` (default `~/.hiveplane/hive-config.json`)
 * with mode 0600 — `adminToken` is a secret. Env vars still take precedence
 * for compat and CI: `HIVEPLANE_ADMIN_TOKEN`, `HIVEPLANE_AUTH_REQUIRED`,
 * `HIVEPLANE_HIVE_HOST`, `HIVEPLANE_HIVE_PORT`, `HIVEPLANE_OPEN_BROWSER`,
 * `HIVEPLANE_INCIDENT_WEBHOOK_URL`, and `HIVEPLANE_INCIDENT_NOTIFY_COMMAND`.
 */
export const HiveOnDiskConfigSchema = z.object({
  /** Admin bearer token. If unset, admin endpoints are disabled (503). */
  adminToken: z.string().min(1).optional(),
  /** Bind host. Default `0.0.0.0` so Bees on the Tailnet/LAN can reach it. */
  host: z.string().min(1).optional(),
  /** Bind port. Default `4483`. */
  port: z.number().int().positive().optional(),
  /**
   * Require signed heartbeats and authenticated admin calls. Default `false`
   * during v0.0.x — flip to `true` for production.
   */
  authRequired: z.boolean().optional(),
  /** Auto-open the dashboard in a browser when the Hive is run interactively. */
  openBrowser: z.boolean().optional(),
  /** Optional webhook target for needs-approval / unresolved incident alerts. */
  incidentNotificationWebhookUrl: z.string().url().optional(),
  /** Optional local command + args. Notification JSON is written to stdin. */
  incidentNotificationCommand: z.array(z.string().min(1)).optional(),
});

export type HiveOnDiskConfig = z.infer<typeof HiveOnDiskConfigSchema>;

export const HIVE_CONFIG_FILENAME = "hive-config.json";

export function getDefaultHiveConfigDir(): string {
  return process.env.HIVEPLANE_CONFIG_DIR ?? join(homedir(), ".hiveplane");
}

export function getHiveConfigPath(configDir = getDefaultHiveConfigDir()): string {
  return join(configDir, HIVE_CONFIG_FILENAME);
}

export function readHiveOnDiskConfig(configDir = getDefaultHiveConfigDir()): HiveOnDiskConfig {
  const path = getHiveConfigPath(configDir);
  if (!existsSync(path)) return {};
  try {
    const raw = readFileSync(path, "utf8");
    if (!raw.trim()) return {};
    return HiveOnDiskConfigSchema.parse(JSON.parse(raw));
  } catch (error) {
    // Don't crash the Hive at boot just because the config got hand-edited
    // into something invalid — log loudly and fall back to env-only mode.
    console.warn(
      `[hive] Could not parse ${path} (${error instanceof Error ? error.message : String(error)}). Falling back to env vars.`,
    );
    return {};
  }
}

export function writeHiveOnDiskConfig(
  config: HiveOnDiskConfig,
  configDir = getDefaultHiveConfigDir(),
): { path: string } {
  const path = getHiveConfigPath(configDir);
  mkdirSync(dirname(path), { recursive: true });
  // Always validate before writing so a callsite can't accidentally persist a
  // bogus shape and brick the next boot.
  const parsed = HiveOnDiskConfigSchema.parse(config);
  writeFileSync(path, `${JSON.stringify(parsed, null, 2)}\n`, { mode: 0o600 });
  // Best-effort — `mode` on `writeFileSync` only applies on file creation.
  // chmod after the write so re-saves don't loosen perms back to whatever
  // umask the user has configured.
  try {
    chmodSync(path, 0o600);
  } catch {
    // ignore — Windows doesn't honor POSIX mode bits, and that's fine.
  }
  return { path };
}
