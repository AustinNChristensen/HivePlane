import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { getDefaultHivePlaneConfigDir } from "./identity.js";
import type { Job, JobType } from "@hiveplane/protocol";

const JobPolicySchema = z
  .object({
    allow: z.array(z.string().min(1)).default([]),
    deny: z.array(z.string().min(1)).default([]),
    requireApproval: z.array(z.string().min(1)).default([]),
  })
  .default({ allow: [], deny: [], requireApproval: [] });

export const BeePolicySchema = z.object({
  runCommand: z
    .object({
      /** Allowed argv[0] basenames. Empty list ⇒ no commands allowed (default deny). */
      allow: z.array(z.string().min(1)).default([]),
      /** Explicitly denied argv[0] basenames. Deny wins over allow. */
      deny: z.array(z.string().min(1)).default([]),
      /** Commands that must be approved by an operator before execution. */
      requireApproval: z.array(z.string().min(1)).default([]),
      /** Bypass the allowlist. ONLY for trusted dev environments. */
      unsafeAllowAll: z.boolean().default(false),
    })
    .default({ allow: [], deny: [], requireApproval: [], unsafeAllowAll: false }),
  jobs: JobPolicySchema,
});

export type BeePolicy = z.input<typeof BeePolicySchema>;
export type NormalizedBeePolicy = z.output<typeof BeePolicySchema>;

export const SAFE_READ_ONLY_COMMANDS = ["hostname", "df", "uptime"];

export const DEFAULT_POLICY: NormalizedBeePolicy = {
  runCommand: {
    allow: SAFE_READ_ONLY_COMMANDS,
    deny: [],
    requireApproval: [],
    unsafeAllowAll: false,
  },
  jobs: { allow: [], deny: [], requireApproval: [] },
};

export const APPROVAL_REQUIRED_JOB_TYPES: JobType[] = [
  "install_runtime",
  "configure_runtime",
  "install_model_backend",
  "configure_model",
  "connect_to_host_gateway",
  "update_bee",
  "repair_imessage_bridge",
];

export type PolicyDecision =
  | { allowed: true }
  | { allowed: false; reason: string; requiresApproval?: boolean; risk?: string };

export function getPolicyPath(configDir = getDefaultHivePlaneConfigDir()): string {
  return join(configDir, "policy.json");
}

export function readBeePolicy(configDir?: string): NormalizedBeePolicy {
  const path = getPolicyPath(configDir);
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return DEFAULT_POLICY;
    throw error;
  }
  const trimmed = raw.trim();
  if (!trimmed) return DEFAULT_POLICY;
  const parsed = BeePolicySchema.safeParse(JSON.parse(trimmed));
  return parsed.success ? parsed.data : DEFAULT_POLICY;
}

/** Allowed iff the basename of `command` (after splitting on /) is on the allowlist. */
export function policyAllowsCommand(policy: BeePolicy, command: string): PolicyDecision {
  const runCommand = BeePolicySchema.parse(policy).runCommand;
  const trimmed = command.trim();
  if (!trimmed) return { allowed: false, reason: "empty command" };

  const basename = trimmed.split("/").pop() ?? trimmed;
  if (runCommand.deny.includes(basename)) {
    return { allowed: false, reason: `local policy explicitly denied '${basename}'` };
  }
  if (runCommand.requireApproval.includes(basename)) {
    return {
      allowed: false,
      requiresApproval: true,
      risk: "external",
      reason: `local policy requires approval for '${basename}'`,
    };
  }
  if (runCommand.unsafeAllowAll) return { allowed: true };
  if (runCommand.allow.includes(basename)) return { allowed: true };
  return {
    allowed: false,
    reason: `local policy denied '${basename}'. Add it to ~/.hiveplane/policy.json runCommand.allow`,
  };
}

export function policyDecisionForJob(policy: BeePolicy, job: Job): PolicyDecision {
  const normalized = BeePolicySchema.parse(policy);
  const jobs = normalized.jobs;
  if (jobs.deny.includes(job.type)) {
    return { allowed: false, reason: `local policy explicitly denied job type '${job.type}'` };
  }
  if (jobs.allow.includes(job.type)) return { allowed: true };
  if (job.type === "run_command") {
    const command = typeof job.payload.command === "string" ? job.payload.command : "";
    return policyAllowsCommand(policy, command);
  }
  if (jobs.requireApproval.includes(job.type) || APPROVAL_REQUIRED_JOB_TYPES.includes(job.type)) {
    return {
      allowed: false,
      requiresApproval: true,
      risk: policyRiskForJob(job),
      reason: `local policy requires approval for job type '${job.type}'`,
    };
  }
  if (job.payload.requiresSecrets === true) {
    return {
      allowed: false,
      requiresApproval: true,
      risk: "credentialed",
      reason: "local policy requires approval for jobs that access secrets",
    };
  }
  return { allowed: true };
}

function policyRiskForJob(job: Job): string {
  switch (job.type) {
    case "install_runtime":
    case "install_model_backend":
    case "update_bee":
      return "write";
    case "connect_to_host_gateway":
      return "external";
    case "repair_imessage_bridge":
      return "credentialed";
    default:
      return "destructive";
  }
}
