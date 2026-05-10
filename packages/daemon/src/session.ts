import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { getDefaultHivePlaneConfigDir } from "./identity.js";

export const HiveSessionSchema = z.object({
  hiveUrl: z.string().url(),
  beeId: z.string().min(1),
  sessionToken: z.string().min(1),
  sessionExpiresAt: z.string().datetime(),
});

export type HiveSession = z.infer<typeof HiveSessionSchema>;

export type HiveSessionPaths = {
  configDir: string;
  sessionPath: string;
};

export function getHiveSessionPaths(configDir = getDefaultHivePlaneConfigDir()): HiveSessionPaths {
  return {
    configDir,
    sessionPath: join(configDir, "session.json"),
  };
}

export function readHiveSession(configDir?: string): HiveSession | undefined {
  const paths = getHiveSessionPaths(configDir);
  let raw: string;
  try {
    raw = readFileSync(paths.sessionPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }

  // Treat empty / cleared files as "no session" rather than schema errors.
  const trimmed = raw.trim();
  if (!trimmed || trimmed === "{}") return undefined;

  const parsed = HiveSessionSchema.safeParse(JSON.parse(trimmed));
  return parsed.success ? parsed.data : undefined;
}

export function writeHiveSession(session: HiveSession, configDir?: string): void {
  const paths = getHiveSessionPaths(configDir);
  mkdirSync(paths.configDir, { recursive: true, mode: 0o700 });
  writeFileSync(paths.sessionPath, `${JSON.stringify(session, null, 2)}\n`, { mode: 0o600 });
}

export function clearHiveSession(configDir?: string): void {
  const paths = getHiveSessionPaths(configDir);
  try {
    unlinkSync(paths.sessionPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
}

export function isSessionExpired(session: HiveSession, now = new Date()): boolean {
  return new Date(session.sessionExpiresAt).getTime() <= now.getTime();
}
