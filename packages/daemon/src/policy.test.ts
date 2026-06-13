import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  policyAllowsCommand,
  readBeePolicy,
  DEFAULT_POLICY,
  SAFE_READ_ONLY_COMMANDS,
} from "./policy.js";

function newDir() {
  return mkdtempSync(join(tmpdir(), "hp-policy-test-"));
}

describe("readBeePolicy", () => {
  it("returns DEFAULT_POLICY when no file exists", () => {
    expect(readBeePolicy(newDir())).toEqual(DEFAULT_POLICY);
  });

  it("returns DEFAULT_POLICY when file is empty or invalid", () => {
    const dir = newDir();
    writeFileSync(join(dir, "policy.json"), "");
    expect(readBeePolicy(dir)).toEqual(DEFAULT_POLICY);

    writeFileSync(join(dir, "policy.json"), '{"runCommand": "not-an-object"}');
    expect(readBeePolicy(dir)).toEqual(DEFAULT_POLICY);
  });

  it("loads a valid allowlist", () => {
    const dir = newDir();
    writeFileSync(
      join(dir, "policy.json"),
      JSON.stringify({ runCommand: { allow: ["git", "ls"] } }),
    );
    const policy = readBeePolicy(dir);
    expect(policy.runCommand.allow).toEqual(["git", "ls"]);
    expect(policy.runCommand.unsafeAllowAll).toBe(false);
  });
});

describe("policyAllowsCommand", () => {
  it("allows safe read-only commands by default", () => {
    for (const command of SAFE_READ_ONLY_COMMANDS) {
      expect(policyAllowsCommand(DEFAULT_POLICY, command).allowed).toBe(true);
    }
  });

  it("denies commands outside the default safe allowlist", () => {
    const decision = policyAllowsCommand(DEFAULT_POLICY, "ls");
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.reason).toContain("policy denied");
    }
  });

  it("allows when basename is on allowlist", () => {
    const policy = { runCommand: { allow: ["git"], unsafeAllowAll: false } };
    expect(policyAllowsCommand(policy, "git").allowed).toBe(true);
    expect(policyAllowsCommand(policy, "/usr/bin/git").allowed).toBe(true);
  });

  it("denies different command even if a similarly-named one is allowed", () => {
    const policy = { runCommand: { allow: ["git"], unsafeAllowAll: false } };
    expect(policyAllowsCommand(policy, "rm").allowed).toBe(false);
  });

  it("unsafeAllowAll bypasses the allowlist", () => {
    const policy = { runCommand: { allow: [], unsafeAllowAll: true } };
    expect(policyAllowsCommand(policy, "rm").allowed).toBe(true);
  });

  it("denies empty command", () => {
    expect(policyAllowsCommand(DEFAULT_POLICY, "").allowed).toBe(false);
    expect(policyAllowsCommand(DEFAULT_POLICY, "   ").allowed).toBe(false);
  });
});
