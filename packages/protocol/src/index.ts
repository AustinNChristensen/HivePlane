import { z } from "zod";

export const IsoDateTimeSchema = z.string().datetime();
export const IdSchema = z.string().min(1);
export const JsonPrimitiveSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);
export type JsonPrimitive = z.infer<typeof JsonPrimitiveSchema>;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([JsonPrimitiveSchema, z.array(JsonValueSchema), z.record(JsonValueSchema)]),
);
export const JsonObjectSchema = z.record(JsonValueSchema);

export const HiveUrlSchema = z.string().url();

export const BeePlatformSchema = z.enum(["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64"]);

export const BeeStatusSchema = z.enum(["online", "degraded", "offline"]);

export const BeeHardwareSchema = z.object({
  platform: BeePlatformSchema,
  hostname: z.string().min(1),
  cpuCores: z.number().int().positive(),
  memoryGb: z.number().positive(),
  gpu: z.string().min(1).optional(),
});

export const BeeCapabilitiesSchema = z.object({
  runtimes: z.array(z.string().min(1)).default([]),
  modelBackends: z.array(z.string().min(1)).default([]),
  models: z.array(z.string().min(1)).default([]),
  tools: z.array(z.string().min(1)).default([]),
  networking: z.array(z.string().min(1)).default([]),
  hardware: BeeHardwareSchema,
});

export const BeeRegistrationRequestSchema = z.object({
  type: z.literal("bee.registration.request"),
  bootstrapToken: z.string().min(1),
  publicKey: z.string().min(1),
  beeName: z.string().min(1),
  daemonVersion: z.string().min(1),
  hiveUrl: HiveUrlSchema,
  labels: z.record(z.string()).default({}),
  capabilities: BeeCapabilitiesSchema,
  requestedAt: IsoDateTimeSchema,
});

export const BeeRegistrationResponseSchema = z.object({
  type: z.literal("bee.registration.response"),
  beeId: IdSchema,
  sessionToken: z.string().min(1),
  sessionExpiresAt: IsoDateTimeSchema,
  acceptedAt: IsoDateTimeSchema,
});

export const BeeHeartbeatSchema = z.object({
  type: z.literal("bee.heartbeat"),
  beeId: IdSchema,
  timestamp: IsoDateTimeSchema,
  daemonVersion: z.string().min(1),
  status: BeeStatusSchema,
  activeJobs: z.number().int().nonnegative(),
  capabilities: BeeCapabilitiesSchema.optional(),
});

export const BootstrapTokenCreateRequestSchema = z.object({
  type: z.literal("bootstrap_token.create.request"),
  beeName: z.string().min(1).optional(),
  profileId: z.string().min(1).optional(),
  expiresInSeconds: z
    .number()
    .int()
    .positive()
    .max(60 * 60 * 24)
    .default(60 * 30),
  labels: z.record(z.string()).default({}),
});

export const BootstrapTokenCreateResponseSchema = z.object({
  type: z.literal("bootstrap_token.create.response"),
  tokenId: IdSchema,
  token: z.string().min(1),
  expiresAt: IsoDateTimeSchema,
  installCommand: z.string().min(1).optional(),
});

export const JobStatusSchema = z.enum([
  "created",
  "queued",
  "assigned",
  "accepted_by_bee",
  "running",
  "waiting_for_approval",
  "succeeded",
  "failed",
  "cancelled",
  "timed_out",
]);

export const JobTypeSchema = z.enum([
  "run_command",
  "install_runtime",
  "configure_runtime",
  "install_model_backend",
  "configure_model",
  "connect_to_host_gateway",
  "run_healthcheck",
]);

export const JobSchema = z.object({
  id: IdSchema,
  type: JobTypeSchema,
  beeId: IdSchema,
  status: JobStatusSchema,
  payload: JsonObjectSchema.default({}),
  timeoutSeconds: z.number().int().positive().optional(),
  createdAt: IsoDateTimeSchema,
  assignedAt: IsoDateTimeSchema.optional(),
});

export const JobAssignmentMessageSchema = z.object({
  type: z.literal("job.assign"),
  job: JobSchema,
});

export const JobCancelMessageSchema = z.object({
  type: z.literal("job.cancel"),
  jobId: IdSchema,
  reason: z.string().min(1).optional(),
  cancelledAt: IsoDateTimeSchema,
});

export const JobEventLevelSchema = z.enum(["debug", "info", "warn", "error"]);
export const JobEventActorSchema = z.enum(["user", "bee", "hive", "system"]);

export const JobEventSchema = z.object({
  id: IdSchema,
  jobId: IdSchema,
  beeId: IdSchema.optional(),
  sequence: z.number().int().nonnegative(),
  type: z.string().min(1),
  level: JobEventLevelSchema,
  actor: JobEventActorSchema,
  actorId: z.string().min(1).optional(),
  data: JsonObjectSchema.default({}),
  createdAt: IsoDateTimeSchema,
});

export const JobEventBatchSchema = z.object({
  type: z.literal("job.events.append"),
  jobId: IdSchema,
  beeId: IdSchema,
  events: z.array(JobEventSchema).min(1),
});

export const JobCompleteRequestSchema = z.object({
  type: z.literal("job.complete"),
  jobId: IdSchema,
  beeId: IdSchema,
  status: z.enum(["succeeded", "failed", "cancelled", "timed_out"]),
  output: JsonObjectSchema.optional(),
  error: JsonObjectSchema.optional(),
  completedAt: IsoDateTimeSchema,
});

export const ApprovalRiskSchema = z.enum([
  "read",
  "write",
  "destructive",
  "external",
  "credentialed",
]);

export const ApprovalRequestSchema = z.object({
  type: z.literal("approval.request"),
  approvalId: IdSchema,
  jobId: IdSchema,
  beeId: IdSchema,
  risk: ApprovalRiskSchema,
  summary: z.string().min(1),
  action: z.string().min(1),
  input: JsonObjectSchema.default({}),
  requestedAt: IsoDateTimeSchema,
  expiresAt: IsoDateTimeSchema.optional(),
});

export const ApprovalDecisionSchema = z.enum(["approved_once", "approved_for_job", "denied"]);

export const ApprovalResolutionSchema = z.object({
  type: z.literal("approval.resolve"),
  approvalId: IdSchema,
  jobId: IdSchema,
  decision: ApprovalDecisionSchema,
  resolvedBy: IdSchema,
  resolvedAt: IsoDateTimeSchema,
  reason: z.string().min(1).optional(),
});

export const ArtifactSchema = z.object({
  id: IdSchema,
  jobId: IdSchema,
  beeId: IdSchema.optional(),
  name: z.string().min(1),
  contentType: z.string().min(1).optional(),
  sizeBytes: z.number().int().nonnegative().optional(),
  sha256: z.string().min(1).optional(),
  localPath: z.string().min(1).optional(),
  storageUrl: z.string().url().optional(),
  metadata: JsonObjectSchema.default({}),
  createdAt: IsoDateTimeSchema,
});

export const HiveToBeeMessageSchema = z.discriminatedUnion("type", [
  JobAssignmentMessageSchema,
  JobCancelMessageSchema,
  ApprovalResolutionSchema,
]);

export const BeeToHiveMessageSchema = z.discriminatedUnion("type", [
  BeeRegistrationRequestSchema,
  BeeHeartbeatSchema,
  JobEventBatchSchema,
  JobCompleteRequestSchema,
  ApprovalRequestSchema,
]);

export type HiveUrl = z.infer<typeof HiveUrlSchema>;
export type BeePlatform = z.infer<typeof BeePlatformSchema>;
export type BeeStatus = z.infer<typeof BeeStatusSchema>;
export type BeeHardware = z.infer<typeof BeeHardwareSchema>;
export type BeeCapabilities = z.infer<typeof BeeCapabilitiesSchema>;
export type BeeRegistrationRequest = z.infer<typeof BeeRegistrationRequestSchema>;
export type BeeRegistrationResponse = z.infer<typeof BeeRegistrationResponseSchema>;
export type BeeHeartbeat = z.infer<typeof BeeHeartbeatSchema>;
export type BootstrapTokenCreateRequest = z.infer<typeof BootstrapTokenCreateRequestSchema>;
export type BootstrapTokenCreateResponse = z.infer<typeof BootstrapTokenCreateResponseSchema>;
export type JobStatus = z.infer<typeof JobStatusSchema>;
export type JobType = z.infer<typeof JobTypeSchema>;
export type Job = z.infer<typeof JobSchema>;
export type JobEvent = z.infer<typeof JobEventSchema>;
export type JobEventBatch = z.infer<typeof JobEventBatchSchema>;
export type ApprovalRequest = z.infer<typeof ApprovalRequestSchema>;
export type ApprovalResolution = z.infer<typeof ApprovalResolutionSchema>;
export type Artifact = z.infer<typeof ArtifactSchema>;
export type HiveToBeeMessage = z.infer<typeof HiveToBeeMessageSchema>;
export type BeeToHiveMessage = z.infer<typeof BeeToHiveMessageSchema>;
