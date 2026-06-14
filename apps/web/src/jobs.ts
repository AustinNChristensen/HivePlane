import { randomBytes } from "node:crypto";
import {
  JobEventBatchSchema,
  JobCompleteRequestSchema,
  JobSchema,
  JobTypeSchema,
  type Job,
  type JobCancelMessage,
  type WorkContext,
  type Artifact,
  type JobEvent,
  type JobStatus,
  type JobType,
  type JsonValue,
} from "@hiveplane/protocol";
import { z } from "zod";

export type JobRecord = {
  id: string;
  beeId: string;
  type: Job["type"];
  status: JobStatus;
  payload: Record<string, JsonValue>;
  context?: WorkContext;
  artifacts: Artifact[];
  timeoutSeconds?: number;
  createdAt: Date;
  assignedAt?: Date;
  cancellationDeliveredAt?: Date;
  completedAt?: Date;
  events: JobEvent[];
  exitCode?: number;
  output?: Record<string, JsonValue>;
  error?: Record<string, JsonValue>;
};

export type JobsState = {
  jobs: Map<string, JobRecord>;
};

export function createJobsState(): JobsState {
  return { jobs: new Map() };
}

export const CreateJobRequestSchema = z.object({
  type: JobTypeSchema,
  payload: z.record(z.unknown()).default({}),
  context: z
    .object({
      sessionId: z.string().min(1).optional(),
      runtime: z.string().min(1).optional(),
      workingDirectory: z.string().min(1).optional(),
      files: z.array(z.string().min(1)).default([]),
      artifacts: z.array(z.string().min(1)).default([]),
      metadata: z.record(z.unknown()).default({}),
    })
    .optional(),
  timeoutSeconds: z.number().int().positive().optional(),
});

export type CreateJobRequest = z.infer<typeof CreateJobRequestSchema>;

export function generateJobId(): string {
  return `job_${randomBytes(8).toString("hex")}`;
}

export function createJob(
  state: JobsState,
  beeId: string,
  request: CreateJobRequest,
  now: Date,
): JobRecord {
  const job: JobRecord = {
    id: generateJobId(),
    beeId,
    type: request.type,
    status: "queued",
    payload: request.payload as Record<string, JsonValue>,
    ...(request.context
      ? { context: request.context as unknown as WorkContext }
      : deriveJobContext(request.payload as Record<string, JsonValue>)),
    artifacts: [],
    ...(request.timeoutSeconds !== undefined ? { timeoutSeconds: request.timeoutSeconds } : {}),
    createdAt: now,
    events: [],
  };
  state.jobs.set(job.id, job);
  return job;
}

export function requireApproval(job: JobRecord): JobRecord {
  job.status = "waiting_for_approval";
  return job;
}

export function approveJob(state: JobsState, jobId: string): JobRecord | null {
  const job = state.jobs.get(jobId);
  if (!job) return null;
  if (job.status !== "waiting_for_approval") return job;
  job.status = "queued";
  return job;
}

export function denyJob(state: JobsState, jobId: string, now: Date): JobRecord | null {
  const job = state.jobs.get(jobId);
  if (!job) return null;
  if (job.status !== "waiting_for_approval") return job;
  job.status = "cancelled";
  job.completedAt = now;
  job.error = { code: "approval_denied", message: "job denied by Hive admin" };
  return job;
}

export function cancelJob(
  state: JobsState,
  jobId: string,
  now: Date,
  reason = "cancelled by Hive admin",
): JobRecord | null {
  const job = state.jobs.get(jobId);
  if (!job) return null;
  if (["succeeded", "failed", "cancelled", "timed_out"].includes(job.status)) return job;
  job.status = "cancelled";
  job.completedAt = now;
  job.error = { code: "job_cancelled", message: reason };
  appendSystemJobEvent(job, now, "job.cancel.requested", "warn", {
    reason,
    delivered: false,
  });
  return job;
}

export function claimPendingJobCancellations(
  state: JobsState,
  beeId: string,
  now: Date,
): JobCancelMessage[] {
  const cancellations: JobCancelMessage[] = [];
  for (const job of state.jobs.values()) {
    if (job.beeId !== beeId) continue;
    if (job.status !== "cancelled") continue;
    if (!job.assignedAt) continue;
    if (job.cancellationDeliveredAt) continue;
    const message: JobCancelMessage = {
      type: "job.cancel",
      jobId: job.id,
      reason:
        typeof job.error?.message === "string" ? job.error.message : "cancelled by Hive admin",
      cancelledAt: (job.completedAt ?? now).toISOString(),
    };
    cancellations.push(message);
    job.cancellationDeliveredAt = now;
    appendSystemJobEvent(job, now, "job.cancel.delivered", "warn", {
      reason: message.reason ?? "cancelled by Hive admin",
      delivered: true,
    });
  }
  return cancellations;
}

/** Atomically transition queued jobs for this bee to "assigned" and return them as Job protos. */
export function claimPendingJobs(
  state: JobsState,
  beeId: string,
  now: Date,
  options: { types?: readonly JobType[]; excludeTypes?: readonly JobType[] } = {},
): Job[] {
  const claimed: Job[] = [];
  const allowedTypes = options.types ? new Set<JobType>(options.types) : undefined;
  const excludedTypes = options.excludeTypes ? new Set<JobType>(options.excludeTypes) : undefined;
  for (const job of state.jobs.values()) {
    if (job.beeId !== beeId) continue;
    if (job.status !== "queued") continue;
    if (allowedTypes && !allowedTypes.has(job.type)) continue;
    if (excludedTypes?.has(job.type)) continue;
    job.status = "assigned";
    job.assignedAt = now;
    claimed.push(toJobProto(job));
  }
  return claimed;
}

export function appendEvents(
  state: JobsState,
  jobId: string,
  events: JobEvent[],
): JobRecord | null {
  const job = state.jobs.get(jobId);
  if (!job) return null;
  if (job.status === "cancelled") {
    job.events.push(...events);
    return job;
  }
  if (job.status === "queued" || job.status === "assigned") {
    job.status = "running";
  }
  job.events.push(...events);
  appendArtifacts(job, artifactsFromEvents(events, job));
  return job;
}

export const CompleteJobRequestSchema = JobCompleteRequestSchema;

export function completeJob(
  state: JobsState,
  jobId: string,
  payload: z.infer<typeof CompleteJobRequestSchema>,
  now: Date,
): JobRecord | null {
  const job = state.jobs.get(jobId);
  if (!job) return null;
  if (job.status === "cancelled") return job;
  job.status = payload.status;
  job.completedAt = now;
  if (payload.output) job.output = payload.output as Record<string, JsonValue>;
  if (payload.error) job.error = payload.error as Record<string, JsonValue>;
  appendArtifacts(job, artifactsFromJobResult(job, payload.completedAt));
  return job;
}

export function findJob(state: JobsState, jobId: string): JobRecord | null {
  return state.jobs.get(jobId) ?? null;
}

export function listJobs(state: JobsState, filter?: { beeId?: string }): JobRecord[] {
  const all = [...state.jobs.values()];
  return filter?.beeId ? all.filter((j) => j.beeId === filter.beeId) : all;
}

export function toJobProto(job: JobRecord): Job {
  return JobSchema.parse({
    id: job.id,
    type: job.type,
    beeId: job.beeId,
    status: job.status,
    payload: job.payload,
    ...(job.context ? { context: job.context } : {}),
    ...(job.artifacts.length ? { artifacts: job.artifacts } : {}),
    ...(job.timeoutSeconds !== undefined ? { timeoutSeconds: job.timeoutSeconds } : {}),
    createdAt: job.createdAt.toISOString(),
    ...(job.assignedAt ? { assignedAt: job.assignedAt.toISOString() } : {}),
  });
}

function appendArtifacts(job: JobRecord, artifacts: Artifact[]): void {
  for (const artifact of artifacts) {
    const key =
      artifact.id ||
      artifact.storageUrl ||
      artifact.localPath ||
      artifact.sha256 ||
      `${artifact.name}:${artifact.sizeBytes ?? ""}`;
    if (
      job.artifacts.some(
        (existing) =>
          existing.id === artifact.id ||
          (artifact.storageUrl && existing.storageUrl === artifact.storageUrl) ||
          (artifact.localPath && existing.localPath === artifact.localPath) ||
          (artifact.sha256 && existing.sha256 === artifact.sha256) ||
          `${existing.name}:${existing.sizeBytes ?? ""}` === key,
      )
    ) {
      continue;
    }
    job.artifacts.push(artifact);
  }
}

function artifactsFromEvents(events: JobEvent[], job: JobRecord): Artifact[] {
  return events.flatMap((event) =>
    normalizeArtifactList(event.data.artifacts, job, event.createdAt),
  );
}

function artifactsFromJobResult(job: JobRecord, createdAt: string): Artifact[] {
  return [
    ...normalizeArtifactList(job.output?.artifacts, job, createdAt),
    ...normalizeArtifactList(job.error?.artifacts, job, createdAt),
  ];
}

function normalizeArtifactList(
  value: JsonValue | undefined,
  job: JobRecord,
  createdAt: string,
): Artifact[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const artifact = normalizeArtifact(item, job, createdAt);
    return artifact ? [artifact] : [];
  });
}

function normalizeArtifact(value: JsonValue, job: JobRecord, createdAt: string): Artifact | null {
  if (typeof value === "string") {
    return {
      id: `art_${randomBytes(6).toString("hex")}`,
      jobId: job.id,
      beeId: job.beeId,
      name: artifactNameFromRef(value),
      ...(value.startsWith("/") || value.startsWith("~") ? { localPath: value } : {}),
      ...(/^https?:\/\//.test(value) ? { storageUrl: value } : {}),
      metadata: {},
      createdAt,
    };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as Record<string, JsonValue>;
  const name =
    typeof input.name === "string"
      ? input.name
      : typeof input.localPath === "string"
        ? artifactNameFromRef(input.localPath)
        : typeof input.storageUrl === "string"
          ? artifactNameFromRef(input.storageUrl)
          : undefined;
  if (!name) return null;
  return {
    id: typeof input.id === "string" ? input.id : `art_${randomBytes(6).toString("hex")}`,
    jobId: typeof input.jobId === "string" ? input.jobId : job.id,
    beeId: typeof input.beeId === "string" ? input.beeId : job.beeId,
    name,
    ...(typeof input.contentType === "string" ? { contentType: input.contentType } : {}),
    ...(typeof input.sizeBytes === "number" && Number.isFinite(input.sizeBytes)
      ? { sizeBytes: Math.max(0, Math.trunc(input.sizeBytes)) }
      : {}),
    ...(typeof input.sha256 === "string" ? { sha256: input.sha256 } : {}),
    ...(typeof input.localPath === "string" ? { localPath: input.localPath } : {}),
    ...(typeof input.storageUrl === "string" ? { storageUrl: input.storageUrl } : {}),
    metadata:
      input.metadata && typeof input.metadata === "object" && !Array.isArray(input.metadata)
        ? (input.metadata as Record<string, JsonValue>)
        : {},
    createdAt: typeof input.createdAt === "string" ? input.createdAt : createdAt,
  };
}

function artifactNameFromRef(value: string): string {
  try {
    const parsed = new URL(value);
    return parsed.pathname.split("/").filter(Boolean).at(-1) || parsed.hostname;
  } catch {
    return value.split("/").filter(Boolean).at(-1) || value;
  }
}

function deriveJobContext(payload: Record<string, JsonValue>): { context: WorkContext } | {} {
  const context: WorkContext = {
    files: [],
    artifacts: [],
    metadata: {},
  };
  if (typeof payload.sessionId === "string") context.sessionId = payload.sessionId;
  if (typeof payload.runtime === "string") context.runtime = payload.runtime;
  if (typeof payload.workingDirectory === "string") {
    context.workingDirectory = payload.workingDirectory;
  }
  if (typeof payload.cwd === "string") context.workingDirectory = payload.cwd;
  if (Array.isArray(payload.files)) {
    context.files = payload.files.filter((item): item is string => typeof item === "string");
  }
  if (Array.isArray(payload.artifacts)) {
    context.artifacts = payload.artifacts.filter(
      (item): item is string => typeof item === "string",
    );
  }
  const hasContext =
    context.sessionId ||
    context.runtime ||
    context.workingDirectory ||
    context.files.length > 0 ||
    context.artifacts.length > 0;
  return hasContext ? { context } : {};
}

export const ParseJobEventBatch = JobEventBatchSchema;

export function appendSystemJobEvent(
  job: JobRecord,
  now: Date,
  type: string,
  level: JobEvent["level"],
  data: Record<string, JsonValue>,
): JobEvent {
  const event = createSystemJobEvent(job, now, type, level, data);
  job.events.push(event);
  return event;
}

function createSystemJobEvent(
  job: JobRecord,
  now: Date,
  type: string,
  level: JobEvent["level"],
  data: Record<string, JsonValue>,
): JobEvent {
  const sequence = job.events.reduce((max, event) => Math.max(max, event.sequence), -1) + 1;
  return {
    id: `evt_${randomBytes(6).toString("hex")}`,
    jobId: job.id,
    beeId: job.beeId,
    sequence,
    type,
    level,
    actor: "hive",
    actorId: "hive",
    data,
    createdAt: now.toISOString(),
  };
}
