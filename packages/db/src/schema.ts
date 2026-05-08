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
