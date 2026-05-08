import { z } from "zod";

export const NodePlatformSchema = z.enum([
  "darwin-arm64",
  "darwin-x64",
  "linux-arm64",
  "linux-x64",
]);

export const NodeHeartbeatSchema = z.object({
  type: z.literal("node.heartbeat"),
  nodeId: z.string().min(1),
  timestamp: z.string().datetime(),
  daemonVersion: z.string().min(1),
  status: z.enum(["online", "degraded", "offline"]),
  activeJobs: z.number().int().nonnegative(),
});

export const NodeJobTypeSchema = z.enum([
  "install_runtime",
  "configure_runtime",
  "install_model_backend",
  "configure_model",
  "connect_to_host_gateway",
  "run_healthcheck",
]);

export const NodeJobSchema = z.object({
  id: z.string().min(1),
  type: NodeJobTypeSchema,
  nodeId: z.string().min(1),
  payload: z.record(z.unknown()).default({}),
  createdAt: z.string().datetime(),
});

export type NodePlatform = z.infer<typeof NodePlatformSchema>;
export type NodeHeartbeat = z.infer<typeof NodeHeartbeatSchema>;
export type NodeJobType = z.infer<typeof NodeJobTypeSchema>;
export type NodeJob = z.infer<typeof NodeJobSchema>;
