import { setTimeout as delay } from "node:timers/promises";
import {
  BeeHeartbeatSchema,
  JobCancelMessageSchema,
  JobSchema,
  type BeeHeartbeat,
  type Job,
  type JobCancelMessage,
} from "@hiveplane/protocol";
import { z } from "zod";
import { createHeartbeat, type DaemonState } from "./index.js";

export type BeeConnectionStatus = "idle" | "connecting" | "connected" | "backing_off" | "stopped";

export type BeeConnectionTransport = {
  postHeartbeat(heartbeat: BeeHeartbeat, signal?: AbortSignal): Promise<BeeHeartbeatResponse>;
};

export type BeeConnectionManagerOptions = {
  state: DaemonState;
  transport: BeeConnectionTransport;
  daemonVersion: string;
  heartbeatIntervalMs?: number;
  retryPolicy?: Partial<BeeRetryPolicy>;
  onStatusChange?: (status: BeeConnectionStatus) => void;
  beforeHeartbeat?: () => Promise<void> | void;
  onJobs?: (jobs: Job[]) => Promise<void> | void;
  onCancellations?: (cancellations: JobCancelMessage[]) => Promise<void> | void;
  onError?: (error: unknown) => void;
};

export type BeeRetryPolicy = {
  initialDelayMs: number;
  maxDelayMs: number;
  multiplier: number;
  jitterRatio: number;
};

const DEFAULT_RETRY_POLICY: BeeRetryPolicy = {
  initialDelayMs: 1_000,
  maxDelayMs: 30_000,
  multiplier: 2,
  jitterRatio: 0.2,
};

export const BeeHeartbeatResponseSchema = z.object({
  accepted: z.boolean().default(true),
  jobs: z.array(JobSchema).default([]),
  cancellations: z.array(JobCancelMessageSchema).default([]),
});

export type BeeHeartbeatResponse = z.infer<typeof BeeHeartbeatResponseSchema>;

export class BeeConnectionManager {
  private readonly heartbeatIntervalMs: number;
  private readonly retryPolicy: BeeRetryPolicy;
  private readonly abortController = new AbortController();
  private runPromise: Promise<void> | undefined;
  private currentStatus: BeeConnectionStatus = "idle";
  private consecutiveFailures = 0;

  constructor(private readonly options: BeeConnectionManagerOptions) {
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? 30_000;
    this.retryPolicy = { ...DEFAULT_RETRY_POLICY, ...options.retryPolicy };
  }

  get status(): BeeConnectionStatus {
    return this.currentStatus;
  }

  get failures(): number {
    return this.consecutiveFailures;
  }

  start(): Promise<void> {
    if (!this.runPromise) {
      this.runPromise = this.runLoop();
    }

    return this.runPromise;
  }

  stop(): void {
    this.abortController.abort();
    this.setStatus("stopped");
  }

  async sendHeartbeat(): Promise<BeeHeartbeatResponse> {
    this.setStatus(this.consecutiveFailures === 0 ? "connecting" : "backing_off");
    await this.options.beforeHeartbeat?.();
    const heartbeat = createHeartbeat(this.options.state, this.options.daemonVersion);
    const response = BeeHeartbeatResponseSchema.parse(
      await this.options.transport.postHeartbeat(heartbeat, this.abortController.signal),
    );

    if (!response.accepted) {
      throw new Error("Hive rejected Bee heartbeat");
    }

    this.consecutiveFailures = 0;
    this.setStatus("connected");

    if (response.cancellations.length > 0) {
      await this.options.onCancellations?.(response.cancellations);
    }

    if (response.jobs.length > 0) {
      await this.options.onJobs?.(response.jobs);
    }

    return response;
  }

  private async runLoop(): Promise<void> {
    while (!this.abortController.signal.aborted) {
      try {
        await this.sendHeartbeat();
        await delay(this.heartbeatIntervalMs, undefined, { signal: this.abortController.signal });
      } catch (error) {
        if (this.abortController.signal.aborted) break;
        this.consecutiveFailures += 1;
        this.options.onError?.(error);
        this.setStatus("backing_off");
        await delay(this.getBackoffDelayMs(), undefined, {
          signal: this.abortController.signal,
        }).catch(() => undefined);
      }
    }

    this.setStatus("stopped");
  }

  private getBackoffDelayMs(): number {
    const exponentialDelay =
      this.retryPolicy.initialDelayMs *
      this.retryPolicy.multiplier ** Math.max(this.consecutiveFailures - 1, 0);
    const cappedDelay = Math.min(exponentialDelay, this.retryPolicy.maxDelayMs);
    const jitterRange = cappedDelay * this.retryPolicy.jitterRatio;
    const jitter = Math.random() * jitterRange * 2 - jitterRange;

    return Math.max(0, Math.round(cappedDelay + jitter));
  }

  private setStatus(status: BeeConnectionStatus): void {
    if (this.currentStatus === status) return;
    this.currentStatus = status;
    this.options.onStatusChange?.(status);
  }
}

export type HttpBeeConnectionTransportOptions = {
  hiveUrl: string;
  fetchImpl?: typeof fetch;
  /** Provides per-request auth headers (session token + signature). Optional during v0.0.x dev mode. */
  authHeaderProvider?: (
    rawBody: Uint8Array,
  ) => Promise<Record<string, string>> | Record<string, string>;
};

export class HttpBeeConnectionTransport implements BeeConnectionTransport {
  constructor(private readonly options: HttpBeeConnectionTransportOptions) {}

  async postHeartbeat(
    heartbeat: BeeHeartbeat,
    signal?: AbortSignal,
  ): Promise<BeeHeartbeatResponse> {
    const fetchImpl = this.options.fetchImpl ?? fetch;
    const url = new URL("/api/bees/heartbeat", this.options.hiveUrl);
    const rawBody = Buffer.from(JSON.stringify(BeeHeartbeatSchema.parse(heartbeat)));
    const headers: Record<string, string> = { "content-type": "application/json" };

    if (this.options.authHeaderProvider) {
      const auth = await this.options.authHeaderProvider(rawBody);
      Object.assign(headers, auth);
    }

    const init: RequestInit = {
      method: "POST",
      headers,
      body: rawBody,
    };

    if (signal) {
      init.signal = signal;
    }

    const response = await fetchImpl(url, init);

    if (!response.ok) {
      throw new Error(`Hive heartbeat failed: ${response.status} ${response.statusText}`);
    }

    return BeeHeartbeatResponseSchema.parse(await response.json());
  }
}
