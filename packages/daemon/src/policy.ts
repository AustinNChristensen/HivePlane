import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { getDefaultHivePlaneConfigDir } from "./identity.js";

export const BeePolicySchema = z.object({
  runCommand: z
    .object({
      /** Allowed argv[0] basenames. Empty list ⇒ no commands allowed (default deny). */
      allow: z.array(z.string().min(1)).default([]),
      /** Bypass the allowlist. ONLY for trusted dev environments. */
      unsafeAllowAll: z.boolean().default(false),
    })
    .default({ allow: [], unsafeAllowAll: false }),
});

export type BeePolicy = z.infer<typeof BeePolicySchema>;

export const DEFAULT_POLICY: BeePolicy = {
  runCommand: { allow: [], unsafeAllowAll: false },
};

export type PolicyDecision = { allowed: true } | { allowed: false; reason: string };

export function getPolicyPath(configDir = getDefaultHivePlaneConfigDir()): string {
  return join(configDir, "policy.json");
}

export function readBeePolicy(configDir?: string): BeePolicy {
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
  if (policy.runCommand.unsafeAllowAll) return { allowed: true };
  const trimmed = command.trim();
  if (!trimmed) return { allowed: false, reason: "empty command" };

  const basename = trimmed.split("/").pop() ?? trimmed;
  if (policy.runCommand.allow.includes(basename)) return { allowed: true };
  return {
    allowed: false,
    reason: `local policy denied '${basename}'. Add it to ~/.hiveplane/policy.json runCommand.allow`,
  };
}
