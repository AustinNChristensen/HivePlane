import { randomUUID } from "node:crypto";
import { hostname, platform, arch, totalmem, cpus } from "node:os";
import { z } from "zod";
import {
  BeeHeartbeatSchema,
  type BeeHeartbeat,
  type BeeCapabilities,
  type BeeHardware,
  type BeeHealthCheck,
  type BeePermissions,
  type BeePlatform,
} from "@hiveplane/protocol";
import { DEFAULT_POLICY } from "./policy.js";

export const DaemonConfigSchema = z.object({
  beeId: z.string().min(1).optional(),
  beeName: z.string().min(1).default(hostname()),
  hiveUrl: z.string().url(),
  heartbeatIntervalSeconds: z.number().int().positive().default(30),
  labels: z.record(z.string()).default({}),
  maxConcurrentJobs: z.number().int().positive().default(1),
});

export type DaemonConfig = z.input<typeof DaemonConfigSchema>;

export type BeeHardwareSnapshot = {
  platform: BeePlatform | "unsupported";
  hostname: string;
  cpuCores: number;
  memoryGb: number;
};

export type DaemonState = {
  beeId: string;
  beeName: string;
  status: "online" | "degraded" | "offline";
  activeJobs: number;
  startedAt: Date;
  hardware: BeeHardwareSnapshot;
  capabilities: BeeCapabilities;
  permissions: BeePermissions;
  healthChecks: BeeHealthCheck[];
};

export function detectBeePlatform(): BeeHardwareSnapshot["platform"] {
  const os = platform();
  const cpuArch = arch();

  if (os === "darwin" && cpuArch === "arm64") return "darwin-arm64";
  if (os === "darwin" && cpuArch === "x64") return "darwin-x64";
  if (os === "linux" && cpuArch === "arm64") return "linux-arm64";
  if (os === "linux" && cpuArch === "x64") return "linux-x64";

  return "unsupported";
}

export function getHardwareSnapshot(): BeeHardwareSnapshot {
  return {
    platform: detectBeePlatform(),
    hostname: hostname(),
    cpuCores: cpus().length,
    memoryGb: Math.round((totalmem() / 1024 ** 3) * 10) / 10,
  };
}

export function createDaemonState(config: DaemonConfig): DaemonState {
  const parsed = DaemonConfigSchema.parse(config);
  const hardware = getHardwareSnapshot();
  const capabilitiesHardware = toCapabilitiesHardware(hardware);

  return {
    beeId: parsed.beeId ?? `bee_${randomUUID()}`,
    beeName: parsed.beeName,
    status: "online",
    activeJobs: 0,
    startedAt: new Date(),
    hardware,
    capabilities: {
      runtimes: [],
      modelBackends: [],
      models: [],
      tools: [],
      networking: [],
      hardware: capabilitiesHardware,
    },
    permissions: DEFAULT_POLICY,
    healthChecks: [],
  };
}

export function createHeartbeat(state: DaemonState, daemonVersion: string): BeeHeartbeat {
  return BeeHeartbeatSchema.parse({
    type: "bee.heartbeat",
    beeId: state.beeId,
    timestamp: new Date().toISOString(),
    daemonVersion,
    status: state.status,
    activeJobs: state.activeJobs,
    capabilities: state.capabilities,
    permissions: state.permissions,
    healthChecks: state.healthChecks,
  });
}

function toCapabilitiesHardware(hardware: BeeHardwareSnapshot): BeeHardware {
  if (hardware.platform === "unsupported") {
    return {
      platform: "linux-x64",
      hostname: hardware.hostname,
      cpuCores: hardware.cpuCores,
      memoryGb: hardware.memoryGb,
    };
  }
  return {
    platform: hardware.platform,
    hostname: hardware.hostname,
    cpuCores: hardware.cpuCores,
    memoryGb: hardware.memoryGb,
  };
}

export * from "./identity.js";
export * from "./connection.js";
export * from "./config.js";
export * from "./session.js";
export * from "./register.js";
export * from "./policy.js";
export * from "./capabilities.js";
export * from "./jobs.js";
