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
  connectors: JobPolicySchema,
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
  connectors: {
    allow: ["filesystem"],
    deny: ["mail", "calendar", "imessage", "github", "browser_automation"],
    requireApproval: [],
  },
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

export type PolicyProfileId =
  | "dev_box"
  | "personal_assistant"
  | "browser_worker"
  | "finance_safe"
  | "read_only_observer"
  | "server_worker";

export type PolicyProfile = {
  id: PolicyProfileId;
  label: string;
  risk: "low" | "medium" | "high";
  description: string;
  policy: NormalizedBeePolicy;
};

const OBSERVE_JOBS: JobType[] = [
  "run_healthcheck",
  "openclaw_status",
  "ollama_status",
  "ollama_list_models",
];
const AGENT_JOBS: JobType[] = [...OBSERVE_JOBS, "agent_task"];

export const POLICY_PROFILES: Record<PolicyProfileId, PolicyProfile> = {
  read_only_observer: {
    id: "read_only_observer",
    label: "Read-only observer",
    risk: "low",
    description: "Health and inventory only. No shell expansion beyond safe read-only commands.",
    policy: DEFAULT_POLICY,
  },
  finance_safe: {
    id: "finance_safe",
    label: "Finance-safe",
    risk: "low",
    description:
      "Allows observation and agent tasks, but keeps writes, installs, and external access gated.",
    policy: {
      runCommand: {
        allow: SAFE_READ_ONLY_COMMANDS,
        deny: ["rm", "mv", "curl", "scp", "ssh", "gh", "git"],
        requireApproval: [],
        unsafeAllowAll: false,
      },
      jobs: { allow: AGENT_JOBS, deny: [], requireApproval: APPROVAL_REQUIRED_JOB_TYPES },
      connectors: {
        allow: ["filesystem"],
        deny: ["mail", "calendar", "imessage"],
        requireApproval: ["github", "browser_automation"],
      },
    },
  },
  personal_assistant: {
    id: "personal_assistant",
    label: "Personal assistant",
    risk: "medium",
    description:
      "Good default for a user machine: agent tasks and status checks, with writes approved.",
    policy: {
      runCommand: {
        allow: [...SAFE_READ_ONLY_COMMANDS, "ls", "cat", "pwd"],
        deny: [],
        requireApproval: ["open", "osascript", "curl", "gh"],
        unsafeAllowAll: false,
      },
      jobs: { allow: AGENT_JOBS, deny: [], requireApproval: APPROVAL_REQUIRED_JOB_TYPES },
      connectors: {
        allow: ["filesystem", "calendar"],
        deny: [],
        requireApproval: ["mail", "imessage", "github", "browser_automation"],
      },
    },
  },
  browser_worker: {
    id: "browser_worker",
    label: "Browser worker",
    risk: "medium",
    description:
      "For browser and app workflows. Runtime changes and external writes still require approval.",
    policy: {
      runCommand: {
        allow: [...SAFE_READ_ONLY_COMMANDS, "open", "osascript"],
        deny: [],
        requireApproval: ["curl", "gh", "git"],
        unsafeAllowAll: false,
      },
      jobs: { allow: AGENT_JOBS, deny: [], requireApproval: APPROVAL_REQUIRED_JOB_TYPES },
      connectors: {
        allow: ["browser_automation", "filesystem"],
        deny: [],
        requireApproval: ["mail", "calendar", "imessage", "github"],
      },
    },
  },
  server_worker: {
    id: "server_worker",
    label: "Server / always-on worker",
    risk: "medium",
    description: "Allows health, agent tasks, and recovery jobs for always-on infrastructure Bees.",
    policy: {
      runCommand: {
        allow: SAFE_READ_ONLY_COMMANDS,
        deny: [],
        requireApproval: ["systemctl", "launchctl", "brew", "pnpm", "git"],
        unsafeAllowAll: false,
      },
      jobs: {
        allow: [...AGENT_JOBS, "restart_bee", "collect_bee_logs", "diagnose_incident"],
        deny: [],
        requireApproval: APPROVAL_REQUIRED_JOB_TYPES,
      },
      connectors: {
        allow: ["filesystem"],
        deny: ["mail", "calendar", "imessage"],
        requireApproval: ["github", "browser_automation"],
      },
    },
  },
  dev_box: {
    id: "dev_box",
    label: "Dev box",
    risk: "high",
    description:
      "Developer workstation preset for repo work. Powerful commands are still explicit.",
    policy: {
      runCommand: {
        allow: [
          ...SAFE_READ_ONLY_COMMANDS,
          "git",
          "gh",
          "pnpm",
          "npm",
          "node",
          "rg",
          "sed",
          "cat",
          "ls",
        ],
        deny: ["rm"],
        requireApproval: ["curl", "ssh", "scp", "brew"],
        unsafeAllowAll: false,
      },
      jobs: {
        allow: [
          ...AGENT_JOBS,
          "configure_model",
          "restart_bee",
          "collect_bee_logs",
          "diagnose_incident",
        ],
        deny: [],
        requireApproval: [
          "install_runtime",
          "install_model_backend",
          "update_bee",
          "connect_to_host_gateway",
        ],
      },
      connectors: {
        allow: ["filesystem", "github", "browser_automation"],
        deny: [],
        requireApproval: ["mail", "calendar", "imessage"],
      },
    },
  },
};

export function policyProfileIds(): PolicyProfileId[] {
  return Object.keys(POLICY_PROFILES) as PolicyProfileId[];
}

export function applyPolicyProfile(id: string): NormalizedBeePolicy {
  const profile = POLICY_PROFILES[id as PolicyProfileId];
  if (!profile) throw new Error(`unknown policy profile: ${id}`);
  return BeePolicySchema.parse(profile.policy);
}

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
  const connectorDecision = policyDecisionForConnectors(normalized, job);
  if (!connectorDecision.allowed) return connectorDecision;
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

function policyDecisionForConnectors(policy: NormalizedBeePolicy, job: Job): PolicyDecision {
  const requested = requestedConnectorsForJob(job);
  for (const connector of requested) {
    if (policy.connectors.deny.includes(connector)) {
      return {
        allowed: false,
        reason: `local policy explicitly denied connector '${connector}'`,
      };
    }
    if (policy.connectors.requireApproval.includes(connector)) {
      return {
        allowed: false,
        requiresApproval: true,
        risk: "external",
        reason: `local policy requires approval for connector '${connector}'`,
      };
    }
    if (policy.connectors.allow.length > 0 && !policy.connectors.allow.includes(connector)) {
      return {
        allowed: false,
        reason: `local policy denied connector '${connector}'. Add it to ~/.hiveplane/policy.json connectors.allow`,
      };
    }
  }
  return { allowed: true };
}

function requestedConnectorsForJob(job: Job): string[] {
  const values: string[] = [];
  const direct = job.payload.connectors;
  if (Array.isArray(direct)) {
    for (const value of direct)
      if (typeof value === "string" && !values.includes(value)) values.push(value);
  }
  const requirements =
    job.payload.requirements &&
    typeof job.payload.requirements === "object" &&
    !Array.isArray(job.payload.requirements)
      ? (job.payload.requirements as Record<string, unknown>)
      : undefined;
  if (Array.isArray(requirements?.connectors)) {
    for (const value of requirements.connectors) {
      if (typeof value === "string" && !values.includes(value)) values.push(value);
    }
  }
  return values;
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
