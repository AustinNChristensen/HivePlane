import { randomBytes } from "node:crypto";
import {
  JobEventBatchSchema,
  JobCompleteRequestSchema,
  JobSchema,
  JobTypeSchema,
  type Job,
  type JobEvent,
  type JobStatus,
  type JsonValue,
} from "@hiveplane/protocol";
import { z } from "zod";

export type JobRecord = {
  id: string;
  beeId: string;
  type: Job["type"];
  status: JobStatus;
  payload: Record<string, JsonValue>;
  timeoutSeconds?: number;
  createdAt: Date;
  assignedAt?: Date;
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

/** Atomically transition queued jobs for this bee to "assigned" and return them as Job protos. */
export function claimPendingJobs(state: JobsState, beeId: string, now: Date): Job[] {
  const claimed: Job[] = [];
  for (const job of state.jobs.values()) {
    if (job.beeId !== beeId) continue;
    if (job.status !== "queued") continue;
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
  if (job.status === "assigned") {
    job.status = "running";
  }
  job.events.push(...events);
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
  job.status = payload.status;
  job.completedAt = now;
  if (payload.output) job.output = payload.output as Record<string, JsonValue>;
  if (payload.error) job.error = payload.error as Record<string, JsonValue>;
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
    ...(job.timeoutSeconds !== undefined ? { timeoutSeconds: job.timeoutSeconds } : {}),
    createdAt: job.createdAt.toISOString(),
    ...(job.assignedAt ? { assignedAt: job.assignedAt.toISOString() } : {}),
  });
}

export const ParseJobEventBatch = JobEventBatchSchema;
