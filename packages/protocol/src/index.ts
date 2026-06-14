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

export const LocalModelCapabilitySchema = z.object({
  backend: z.string().min(1),
  name: z.string().min(1),
  endpointUrl: z.string().url().optional(),
  contextLength: z.number().int().positive().optional(),
  quantization: z.string().min(1).optional(),
  resourceHints: JsonObjectSchema.default({}),
});

export const AgentSessionCapabilitySchema = z.object({
  id: z.string().min(1),
  runtime: z.string().min(1),
  label: z.string().min(1).optional(),
  status: z.enum(["active", "recent", "stale"]).default("recent"),
  taskId: z.string().min(1).optional(),
  workingDirectory: z.string().min(1).optional(),
  updatedAt: IsoDateTimeSchema,
  metadata: JsonObjectSchema.default({}),
});

export const ConnectorCapabilitySchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  kind: z.enum(["local_app", "cloud", "filesystem", "repo", "browser", "messaging", "model"]),
  status: z.enum(["available", "degraded", "unavailable", "unknown"]).default("unknown"),
  lastCheckedAt: IsoDateTimeSchema.optional(),
  details: JsonObjectSchema.default({}),
});

export const BeeCapabilitiesSchema = z.object({
  runtimes: z.array(z.string().min(1)).default([]),
  modelBackends: z.array(z.string().min(1)).default([]),
  models: z.array(z.string().min(1)).default([]),
  localModels: z.array(LocalModelCapabilitySchema).default([]),
  agentSessions: z.array(AgentSessionCapabilitySchema).optional(),
  connectors: z.array(ConnectorCapabilitySchema).optional(),
  tools: z.array(z.string().min(1)).default([]),
  networking: z.array(z.string().min(1)).default([]),
  hardware: BeeHardwareSchema,
});

export const BeeHealthCheckSchema = z.object({
  name: z.string().min(1),
  status: z.enum(["passing", "failing", "unknown"]),
  checkedAt: IsoDateTimeSchema,
  message: z.string().max(500).optional(),
});

export const BeePermissionsSchema = z.object({
  runCommand: z
    .object({
      allow: z.array(z.string().min(1)).default([]),
      deny: z.array(z.string().min(1)).default([]),
      requireApproval: z.array(z.string().min(1)).default([]),
      unsafeAllowAll: z.boolean().default(false),
    })
    .default({ allow: [], deny: [], requireApproval: [], unsafeAllowAll: false }),
  jobs: z
    .object({
      allow: z.array(z.string().min(1)).default([]),
      deny: z.array(z.string().min(1)).default([]),
      requireApproval: z.array(z.string().min(1)).default([]),
    })
    .default({ allow: [], deny: [], requireApproval: [] }),
  connectors: z
    .object({
      allow: z.array(z.string().min(1)).default([]),
      deny: z.array(z.string().min(1)).default([]),
      requireApproval: z.array(z.string().min(1)).default([]),
    })
    .default({ allow: [], deny: [], requireApproval: [] }),
});

export const RescueCapabilitiesSchema = z.object({
  actions: z.array(z.string().min(1)).default([]),
  hardware: BeeHardwareSchema,
});

export const RescueHeartbeatSchema = z.object({
  type: z.literal("rescue.heartbeat"),
  beeId: IdSchema,
  timestamp: IsoDateTimeSchema,
  rescueVersion: z.string().min(1),
  status: z.enum(["online", "degraded"]),
  capabilities: RescueCapabilitiesSchema,
});

/**
 * Plain object form of the registration request. Kept as a `ZodObject` so it
 * can participate in `BeeToHiveMessageSchema`'s discriminated union.
 *
 * The "exactly one of bootstrapToken / pairingKey" cross-field constraint
 * lives on `BeeRegistrationRequestSchema` below — the server uses the refined
 * schema for direct parsing, and the union schema for type discrimination
 * only.
 */
export const BeeRegistrationRequestObjectSchema = z.object({
  type: z.literal("bee.registration.request"),
  /**
   * Long-form bootstrap token (`hp_boot_…`). Either this OR `pairingKey`
   * must be supplied. Bootstrap tokens are admin-minted, single-use, and
   * intended for scripted installs.
   */
  bootstrapToken: z.string().min(1).optional(),
  /**
   * Short human-typeable pairing key (`hp_pair_…`). Either this OR
   * `bootstrapToken` must be supplied. Pairing keys are 8 Crockford-base32
   * chars, displayed in the Hive dashboard, and rotate after each use.
   */
  pairingKey: z.string().min(1).optional(),
  publicKey: z.string().min(1),
  beeName: z.string().min(1),
  daemonVersion: z.string().min(1),
  hiveUrl: HiveUrlSchema,
  labels: z.record(z.string()).default({}),
  capabilities: BeeCapabilitiesSchema,
  requestedAt: IsoDateTimeSchema,
});

export const BeeRegistrationRequestSchema = BeeRegistrationRequestObjectSchema.refine(
  (req) => Boolean(req.bootstrapToken) !== Boolean(req.pairingKey),
  {
    message: "exactly one of bootstrapToken or pairingKey must be provided",
    path: ["bootstrapToken"],
  },
);

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
  permissions: BeePermissionsSchema.optional(),
  healthChecks: z.array(BeeHealthCheckSchema).default([]),
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

export const WorkContextSchema = z
  .object({
    sessionId: z.string().min(1).optional(),
    runtime: z.string().min(1).optional(),
    workingDirectory: z.string().min(1).optional(),
    files: z.array(z.string().min(1)).default([]),
    artifacts: z.array(z.string().min(1)).default([]),
    metadata: JsonObjectSchema.default({}),
  })
  .default({});

export const JobTypeSchema = z.enum([
  "run_command",
  "install_runtime",
  "configure_runtime",
  "install_model_backend",
  "configure_model",
  "ollama_start",
  "ollama_pull_model",
  "ollama_smoke_test",
  "connect_to_host_gateway",
  "run_healthcheck",
  "openclaw_status",
  "ollama_status",
  "ollama_list_models",
  "update_bee",
  "restart_bee",
  "collect_bee_logs",
  "diagnose_incident",
  "restart_openclaw_gateway",
  "restart_hermes_gateway",
  "repair_imessage_bridge",
  "agent_task",
]);

export const JobSchema = z.object({
  id: IdSchema,
  type: JobTypeSchema,
  beeId: IdSchema,
  status: JobStatusSchema,
  payload: JsonObjectSchema.default({}),
  context: WorkContextSchema.optional(),
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

export type JobCancelMessage = z.infer<typeof JobCancelMessageSchema>;

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
  // The discriminator only inspects `type`, so the plain-object form is
  // sufficient. Cross-field validation (exactly-one auth credential) lives
  // on `BeeRegistrationRequestSchema`, which the server uses directly.
  BeeRegistrationRequestObjectSchema,
  BeeHeartbeatSchema,
  RescueHeartbeatSchema,
  JobEventBatchSchema,
  JobCompleteRequestSchema,
  ApprovalRequestSchema,
]);

export type HiveUrl = z.infer<typeof HiveUrlSchema>;
export type BeePlatform = z.infer<typeof BeePlatformSchema>;
export type BeeStatus = z.infer<typeof BeeStatusSchema>;
export type BeeHardware = z.infer<typeof BeeHardwareSchema>;
export type LocalModelCapability = z.infer<typeof LocalModelCapabilitySchema>;
export type AgentSessionCapability = z.infer<typeof AgentSessionCapabilitySchema>;
export type ConnectorCapability = z.infer<typeof ConnectorCapabilitySchema>;
export type BeeCapabilities = z.infer<typeof BeeCapabilitiesSchema>;
export type BeeHealthCheck = z.infer<typeof BeeHealthCheckSchema>;
export type BeePermissions = z.input<typeof BeePermissionsSchema>;
export type RescueCapabilities = z.infer<typeof RescueCapabilitiesSchema>;
export type RescueHeartbeat = z.infer<typeof RescueHeartbeatSchema>;
export type BeeRegistrationRequest = z.infer<typeof BeeRegistrationRequestSchema>;
export type BeeRegistrationResponse = z.infer<typeof BeeRegistrationResponseSchema>;
export type BeeHeartbeat = z.infer<typeof BeeHeartbeatSchema>;
export type BootstrapTokenCreateRequest = z.infer<typeof BootstrapTokenCreateRequestSchema>;
export type BootstrapTokenCreateResponse = z.infer<typeof BootstrapTokenCreateResponseSchema>;
export type JobStatus = z.infer<typeof JobStatusSchema>;
export type JobType = z.infer<typeof JobTypeSchema>;
export type WorkContext = z.infer<typeof WorkContextSchema>;
export type Job = z.infer<typeof JobSchema>;
export type JobEvent = z.infer<typeof JobEventSchema>;
export type JobEventBatch = z.infer<typeof JobEventBatchSchema>;
export type ApprovalRequest = z.infer<typeof ApprovalRequestSchema>;
export type ApprovalResolution = z.infer<typeof ApprovalResolutionSchema>;
export type Artifact = z.infer<typeof ArtifactSchema>;
export type HiveToBeeMessage = z.infer<typeof HiveToBeeMessageSchema>;
export type BeeToHiveMessage = z.infer<typeof BeeToHiveMessageSchema>;
