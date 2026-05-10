import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  clearHiveSession,
  getHiveSessionPaths,
  isSessionExpired,
  readHiveSession,
  writeHiveSession,
} from "./session.js";

function newDir() {
  return mkdtempSync(join(tmpdir(), "hp-session-test-"));
}

describe("hive session", () => {
  it("returns undefined when no session file exists", () => {
    const dir = newDir();
    expect(readHiveSession(dir)).toBeUndefined();
  });

  it("writes and reads a session", () => {
    const dir = newDir();
    const session = {
      hiveUrl: "https://hive.example/",
      beeId: "bee_abc",
      sessionToken: "hp_sess_xyz",
      sessionExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
    writeHiveSession(session, dir);

    const loaded = readHiveSession(dir);
    expect(loaded).toEqual(session);

    const paths = getHiveSessionPaths(dir);
    const raw = readFileSync(paths.sessionPath, "utf8");
    expect(raw).toContain("hp_sess_xyz");
  });

  it("clearHiveSession empties the file", () => {
    const dir = newDir();
    writeHiveSession(
      {
        hiveUrl: "https://hive.example/",
        beeId: "bee_abc",
        sessionToken: "hp_sess_xyz",
        sessionExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
      dir,
    );
    clearHiveSession(dir);

    expect(readHiveSession(dir)).toBeUndefined();
  });

  it("isSessionExpired", () => {
    const future = {
      hiveUrl: "https://hive.example/",
      beeId: "bee",
      sessionToken: "hp_sess_x",
      sessionExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
    const past = { ...future, sessionExpiresAt: new Date(Date.now() - 60_000).toISOString() };
    expect(isSessionExpired(future)).toBe(false);
    expect(isSessionExpired(past)).toBe(true);
  });
});
