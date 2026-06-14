import {
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

export const orgRoleEnum = pgEnum("org_role", [
  "owner",
  "admin",
  "developer",
  "operator",
  "viewer",
]);
export const beeStatusEnum = pgEnum("bee_status", ["online", "degraded", "offline", "revoked"]);
export const jobStatusEnum = pgEnum("job_status", [
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
export const jobEventLevelEnum = pgEnum("job_event_level", ["debug", "info", "warn", "error"]);
export const jobEventActorEnum = pgEnum("job_event_actor", ["user", "bee", "hive", "system"]);
export const approvalStatusEnum = pgEnum("approval_status", [
  "pending",
  "approved",
  "denied",
  "expired",
]);
export const approvalRiskEnum = pgEnum("approval_risk", [
  "read",
  "write",
  "destructive",
  "external",
  "credentialed",
]);
export const systemRiskEnum = pgEnum("system_risk", ["low", "medium", "high", "critical"]);
export const systemPermissionEnum = pgEnum("system_permission", [
  "view",
  "run",
  "approve",
  "admin",
  "audit",
]);
export const beeSystemAccessModeEnum = pgEnum("bee_system_access_mode", [
  "none",
  "limited",
  "universal",
]);
export const runtimeHealthEnum = pgEnum("runtime_health", [
  "unknown",
  "healthy",
  "degraded",
  "offline",
]);

const createdAt = timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = timestamp("updated_at", { withTimezone: true }).notNull().defaultNow();

export const organizations = pgTable("organizations", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  slug: text("slug").notNull(),
  createdAt,
  updatedAt,
});

export const users = pgTable("users", {
  id: text("id").primaryKey(),
  email: text("email").notNull(),
  name: text("name"),
  createdAt,
  updatedAt,
});

export const organizationMemberships = pgTable(
  "organization_memberships",
  {
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: orgRoleEnum("role").notNull(),
    createdAt,
  },
  (table) => ({
    pk: primaryKey({ columns: [table.organizationId, table.userId] }),
  }),
);

export const systems = pgTable(
  "systems",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    risk: systemRiskEnum("risk").notNull().default("medium"),
    ownerUserId: text("owner_user_id").references(() => users.id, { onDelete: "set null" }),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt,
    updatedAt,
  },
  (table) => ({
    organizationSlugIdx: uniqueIndex("systems_org_slug_idx").on(table.organizationId, table.slug),
    organizationRiskIdx: index("systems_org_risk_idx").on(table.organizationId, table.risk),
  }),
);

export const userSystemPermissions = pgTable(
  "user_system_permissions",
  {
    systemId: text("system_id")
      .notNull()
      .references(() => systems.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    permission: systemPermissionEnum("permission").notNull(),
    grantedByUserId: text("granted_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt,
  },
  (table) => ({
    pk: primaryKey({ columns: [table.systemId, table.userId, table.permission] }),
    userIdx: index("user_system_permissions_user_idx").on(table.userId),
  }),
);

export const bees = pgTable(
  "bees",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    publicKey: text("public_key").notNull(),
    status: beeStatusEnum("status").notNull().default("offline"),
    accessMode: beeSystemAccessModeEnum("access_mode").notNull().default("limited"),
    hiveUrl: text("hive_url"),
    daemonVersion: text("daemon_version"),
    labels: jsonb("labels").$type<Record<string, string>>().notNull().default({}),
    capabilities: jsonb("capabilities").$type<Record<string, unknown>>().notNull().default({}),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt,
    updatedAt,
  },
  (table) => ({
    organizationStatusIdx: index("bees_org_status_idx").on(table.organizationId, table.status),
    organizationNameIdx: index("bees_org_name_idx").on(table.organizationId, table.name),
  }),
);

export const beeSystemAccess = pgTable(
  "bee_system_access",
  {
    beeId: text("bee_id")
      .notNull()
      .references(() => bees.id, { onDelete: "cascade" }),
    systemId: text("system_id")
      .notNull()
      .references(() => systems.id, { onDelete: "cascade" }),
    grantedByUserId: text("granted_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt,
  },
  (table) => ({
    pk: primaryKey({ columns: [table.beeId, table.systemId] }),
    systemIdx: index("bee_system_access_system_idx").on(table.systemId),
  }),
);

export const beeSessions = pgTable(
  "bee_sessions",
  {
    id: text("id").primaryKey(),
    beeId: text("bee_id")
      .notNull()
      .references(() => bees.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt,
  },
  (table) => ({
    beeIdx: index("bee_sessions_bee_idx").on(table.beeId),
  }),
);

export const bootstrapTokens = pgTable(
  "bootstrap_tokens",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    beeName: text("bee_name"),
    profileId: text("profile_id"),
    labels: jsonb("labels").$type<Record<string, string>>().notNull().default({}),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    usedByBeeId: text("used_by_bee_id").references(() => bees.id, { onDelete: "set null" }),
    createdByUserId: text("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt,
  },
  (table) => ({
    tokenHashIdx: uniqueIndex("bootstrap_tokens_hash_idx").on(table.tokenHash),
    organizationIdx: index("bootstrap_tokens_org_idx").on(table.organizationId),
  }),
);

export const jobs = pgTable(
  "jobs",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    beeId: text("bee_id").references(() => bees.id, { onDelete: "set null" }),
    targetSystemId: text("target_system_id").references(() => systems.id, {
      onDelete: "set null",
    }),
    requestedSubAgentId: text("requested_sub_agent_id").references(() => subAgentDefinitions.id, {
      onDelete: "set null",
    }),
    modelBackendId: text("model_backend_id").references(() => modelBackends.id, {
      onDelete: "set null",
    }),
    localModelId: text("local_model_id").references(() => localModels.id, {
      onDelete: "set null",
    }),
    requestedByUserId: text("requested_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    type: text("type").notNull(),
    status: jobStatusEnum("status").notNull().default("created"),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
    output: jsonb("output").$type<Record<string, unknown>>(),
    error: jsonb("error").$type<Record<string, unknown>>(),
    timeoutSeconds: integer("timeout_seconds"),
    queuedAt: timestamp("queued_at", { withTimezone: true }),
    assignedAt: timestamp("assigned_at", { withTimezone: true }),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt,
    updatedAt,
  },
  (table) => ({
    organizationStatusIdx: index("jobs_org_status_idx").on(table.organizationId, table.status),
    beeStatusIdx: index("jobs_bee_status_idx").on(table.beeId, table.status),
    targetSystemStatusIdx: index("jobs_system_status_idx").on(table.targetSystemId, table.status),
    subAgentStatusIdx: index("jobs_sub_agent_status_idx").on(
      table.requestedSubAgentId,
      table.status,
    ),
    modelBackendStatusIdx: index("jobs_model_backend_status_idx").on(
      table.modelBackendId,
      table.status,
    ),
    localModelStatusIdx: index("jobs_local_model_status_idx").on(table.localModelId, table.status),
  }),
);

export const subAgentDefinitions = pgTable(
  "sub_agent_definitions",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    systemId: text("system_id").references(() => systems.id, { onDelete: "set null" }),
    name: text("name").notNull(),
    runtime: text("runtime").notNull(),
    modelProvider: text("model_provider"),
    model: text("model"),
    tools: jsonb("tools").$type<string[]>().notNull().default([]),
    skills: jsonb("skills").$type<string[]>().notNull().default([]),
    workingDirectories: jsonb("working_directories").$type<string[]>().notNull().default([]),
    environmentRefs: jsonb("environment_refs").$type<string[]>().notNull().default([]),
    policyProfileId: text("policy_profile_id"),
    targetBeeIds: jsonb("target_bee_ids").$type<string[]>().notNull().default([]),
    enabled: boolean("enabled").notNull().default(true),
    createdAt,
    updatedAt,
  },
  (table) => ({
    organizationRuntimeIdx: index("sub_agents_org_runtime_idx").on(
      table.organizationId,
      table.runtime,
    ),
    systemIdx: index("sub_agents_system_idx").on(table.systemId),
  }),
);

export const beeSubAgents = pgTable(
  "bee_sub_agents",
  {
    beeId: text("bee_id")
      .notNull()
      .references(() => bees.id, { onDelete: "cascade" }),
    subAgentId: text("sub_agent_id")
      .notNull()
      .references(() => subAgentDefinitions.id, { onDelete: "cascade" }),
    runtime: text("runtime").notNull(),
    runtimeAgentId: text("runtime_agent_id"),
    status: runtimeHealthEnum("status").notNull().default("unknown"),
    configPath: text("config_path"),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
    lastSmokeTestAt: timestamp("last_smoke_test_at", { withTimezone: true }),
    lastError: text("last_error"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    createdAt,
    updatedAt,
  },
  (table) => ({
    pk: primaryKey({ columns: [table.beeId, table.subAgentId] }),
    runtimeIdx: index("bee_sub_agents_runtime_idx").on(table.beeId, table.runtime),
  }),
);

export const modelBackends = pgTable(
  "model_backends",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    beeId: text("bee_id")
      .notNull()
      .references(() => bees.id, { onDelete: "cascade" }),
    backend: text("backend").notNull(),
    endpointUrl: text("endpoint_url"),
    status: runtimeHealthEnum("status").notNull().default("unknown"),
    version: text("version"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
    createdAt,
    updatedAt,
  },
  (table) => ({
    beeBackendIdx: uniqueIndex("model_backends_bee_backend_idx").on(table.beeId, table.backend),
    organizationBackendIdx: index("model_backends_org_backend_idx").on(
      table.organizationId,
      table.backend,
    ),
  }),
);

export const localModels = pgTable(
  "local_models",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    backendId: text("backend_id")
      .notNull()
      .references(() => modelBackends.id, { onDelete: "cascade" }),
    beeId: text("bee_id")
      .notNull()
      .references(() => bees.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    family: text("family"),
    quantization: text("quantization"),
    contextLength: integer("context_length"),
    parameterCount: text("parameter_count"),
    resourceHints: jsonb("resource_hints").$type<Record<string, unknown>>().notNull().default({}),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
    createdAt,
    updatedAt,
  },
  (table) => ({
    backendNameIdx: uniqueIndex("local_models_backend_name_idx").on(table.backendId, table.name),
    beeNameIdx: index("local_models_bee_name_idx").on(table.beeId, table.name),
  }),
);

export const jobEvents = pgTable(
  "job_events",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    jobId: text("job_id")
      .notNull()
      .references(() => jobs.id, { onDelete: "cascade" }),
    beeId: text("bee_id").references(() => bees.id, { onDelete: "set null" }),
    targetSystemId: text("target_system_id").references(() => systems.id, {
      onDelete: "set null",
    }),
    sequence: integer("sequence").notNull(),
    type: text("type").notNull(),
    level: jobEventLevelEnum("level").notNull(),
    actor: jobEventActorEnum("actor").notNull(),
    actorId: text("actor_id"),
    data: jsonb("data").$type<Record<string, unknown>>().notNull().default({}),
    createdAt,
  },
  (table) => ({
    jobSequenceIdx: uniqueIndex("job_events_job_sequence_idx").on(table.jobId, table.sequence),
    jobIdx: index("job_events_job_idx").on(table.jobId),
  }),
);

export const approvals = pgTable(
  "approvals",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    jobId: text("job_id")
      .notNull()
      .references(() => jobs.id, { onDelete: "cascade" }),
    beeId: text("bee_id").references(() => bees.id, { onDelete: "set null" }),
    status: approvalStatusEnum("status").notNull().default("pending"),
    risk: approvalRiskEnum("risk").notNull(),
    action: text("action").notNull(),
    summary: text("summary").notNull(),
    input: jsonb("input").$type<Record<string, unknown>>().notNull().default({}),
    requestedAt: timestamp("requested_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    resolvedByUserId: text("resolved_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    decision: text("decision"),
    reason: text("reason"),
    createdAt,
    updatedAt,
  },
  (table) => ({
    organizationStatusIdx: index("approvals_org_status_idx").on(table.organizationId, table.status),
    jobIdx: index("approvals_job_idx").on(table.jobId),
  }),
);

export const artifacts = pgTable(
  "artifacts",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    jobId: text("job_id")
      .notNull()
      .references(() => jobs.id, { onDelete: "cascade" }),
    beeId: text("bee_id").references(() => bees.id, { onDelete: "set null" }),
    name: text("name").notNull(),
    contentType: text("content_type"),
    sizeBytes: integer("size_bytes"),
    sha256: text("sha256"),
    storageUrl: text("storage_url"),
    localPath: text("local_path"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    createdAt,
  },
  (table) => ({
    jobIdx: index("artifacts_job_idx").on(table.jobId),
  }),
);

export const auditLogs = pgTable(
  "audit_logs",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    actorType: text("actor_type").notNull(),
    actorId: text("actor_id"),
    action: text("action").notNull(),
    resourceType: text("resource_type"),
    resourceId: text("resource_id"),
    data: jsonb("data").$type<Record<string, unknown>>().notNull().default({}),
    createdAt,
  },
  (table) => ({
    organizationCreatedIdx: index("audit_logs_org_created_idx").on(
      table.organizationId,
      table.createdAt,
    ),
  }),
);

export const hiveSettings = pgTable("hive_settings", {
  organizationId: text("organization_id")
    .primaryKey()
    .references(() => organizations.id, { onDelete: "cascade" }),
  hiveUrl: text("hive_url"),
  tailscaleRecommended: boolean("tailscale_recommended").notNull().default(true),
  createdAt,
  updatedAt,
});
