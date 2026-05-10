import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { getDefaultHivePlaneConfigDir } from "./identity.js";

export const HivePlaneConfigSchema = z.object({
  hiveUrl: z.string().url().optional(),
  beeName: z.string().min(1).optional(),
  heartbeatIntervalSeconds: z.number().int().positive().optional(),
});

export type HivePlaneConfig = z.infer<typeof HivePlaneConfigSchema>;

export type HivePlaneConfigPaths = {
  configDir: string;
  configPath: string;
};

export function getHivePlaneConfigPaths(
  configDir = getDefaultHivePlaneConfigDir(),
): HivePlaneConfigPaths {
  return {
    configDir,
    configPath: join(configDir, "config.json"),
  };
}

export function readHivePlaneConfig(configDir?: string): HivePlaneConfig {
  const paths = getHivePlaneConfigPaths(configDir);
  try {
    return HivePlaneConfigSchema.parse(JSON.parse(readFileSync(paths.configPath, "utf8")));
  } catch (error) {
    if (isMissingConfigError(error)) return {};
    throw error;
  }
}

export function writeHivePlaneConfig(config: HivePlaneConfig, configDir?: string): void {
  const paths = getHivePlaneConfigPaths(configDir);
  mkdirSync(paths.configDir, { recursive: true, mode: 0o700 });
  const merged = HivePlaneConfigSchema.parse({ ...readHivePlaneConfig(configDir), ...config });
  writeFileSync(paths.configPath, `${JSON.stringify(merged, null, 2)}\n`, { mode: 0o600 });
}

export function clearHiveUrl(configDir?: string): void {
  const paths = getHivePlaneConfigPaths(configDir);
  const existing = readHivePlaneConfig(configDir);
  const { hiveUrl: _hiveUrl, ...rest } = existing;
  mkdirSync(paths.configDir, { recursive: true, mode: 0o700 });
  writeFileSync(paths.configPath, `${JSON.stringify(rest, null, 2)}\n`, { mode: 0o600 });
}

function isMissingConfigError(error: unknown): boolean {
  return (
    error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}
