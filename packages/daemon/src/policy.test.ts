import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  policyDecisionForJob,
  policyAllowsCommand,
  policyProfileIds,
  applyPolicyProfile,
  readBeePolicy,
  DEFAULT_POLICY,
  POLICY_PROFILES,
  SAFE_READ_ONLY_COMMANDS,
} from "./policy.js";
import type { Job } from "@hiveplane/protocol";

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

  it("denies commands on the explicit denylist even when allowlisted", () => {
    const policy = { runCommand: { allow: ["git"], deny: ["git"], unsafeAllowAll: false } };
    expect(policyAllowsCommand(policy, "git").allowed).toBe(false);
  });

  it("requires approval for commands on the approval list", () => {
    const policy = { runCommand: { allow: ["brew"], requireApproval: ["brew"] } };
    const decision = policyAllowsCommand(policy, "brew");
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.requiresApproval).toBe(true);
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

describe("policy profiles", () => {
  it("exposes the common Bee role profiles", () => {
    expect(policyProfileIds()).toEqual([
      "read_only_observer",
      "finance_safe",
      "personal_assistant",
      "browser_worker",
      "server_worker",
      "dev_box",
    ]);
    expect(POLICY_PROFILES.dev_box.risk).toBe("high");
    expect(POLICY_PROFILES.finance_safe.risk).toBe("low");
  });

  it("applies a normalized profile policy", () => {
    const policy = applyPolicyProfile("dev_box");
    expect(policy.runCommand.allow).toContain("git");
    expect(policy.runCommand.deny).toContain("rm");
    expect(policy.runCommand.unsafeAllowAll).toBe(false);
    expect(policy.jobs.allow).toContain("agent_task");
  });

  it("rejects an unknown profile", () => {
    expect(() => applyPolicyProfile("root_everything")).toThrow("unknown policy profile");
  });
});

describe("policyDecisionForJob", () => {
  function job(type: Job["type"], payload: Job["payload"] = {}): Job {
    return {
      id: "job_1",
      beeId: "bee_1",
      status: "assigned",
      type,
      payload,
      createdAt: new Date().toISOString(),
    };
  }

  it("requires approval for dangerous jobs by default", () => {
    const decision = policyDecisionForJob(DEFAULT_POLICY, job("install_runtime"));
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.requiresApproval).toBe(true);
      expect(decision.risk).toBe("write");
    }
  });

  it("allows dangerous jobs when explicitly allowed by local policy", () => {
    expect(
      policyDecisionForJob(
        { ...DEFAULT_POLICY, jobs: { allow: ["install_runtime"] } },
        job("install_runtime"),
      ).allowed,
    ).toBe(true);
  });

  it("requires approval when a job says it needs secrets", () => {
    const decision = policyDecisionForJob(
      DEFAULT_POLICY,
      job("run_healthcheck", { requiresSecrets: true }),
    );
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.risk).toBe("credentialed");
  });
});
