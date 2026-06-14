import { describe, expect, it } from "vitest";
import {
  ApprovalRequestSchema,
  BeeHeartbeatSchema,
  BeeRegistrationRequestSchema,
  HiveToBeeMessageSchema,
  JobEventBatchSchema,
  JobSchema,
  RescueHeartbeatSchema,
  type BeeCapabilities,
} from "./index.js";

const capabilities: BeeCapabilities = {
  runtimes: ["openclaw"],
  modelBackends: ["ollama"],
  models: ["qwen2.5-coder:7b"],
  localModels: [
    {
      backend: "ollama",
      name: "qwen2.5-coder:7b",
      endpointUrl: "http://127.0.0.1:11434",
      resourceHints: {},
    },
  ],
  agentSessions: [
    {
      id: "hiveplane-task-task_123",
      runtime: "openclaw",
      status: "recent",
      taskId: "task_123",
      workingDirectory: "/repo",
      updatedAt: "2026-05-08T20:00:00.000Z",
      metadata: {},
    },
  ],
  connectors: [
    {
      id: "github",
      label: "GitHub",
      kind: "cloud",
      status: "available",
      lastCheckedAt: "2026-05-08T20:00:00.000Z",
      details: {},
    },
  ],
  tools: ["shell", "filesystem"],
  networking: ["tailscale"],
  hardware: {
    platform: "darwin-arm64",
    hostname: "bee-mini",
    cpuCores: 10,
    memoryGb: 32,
    gpu: "apple_m4",
  },
};

describe("bee registration", () => {
  it("validates a registration request", () => {
    const parsed = BeeRegistrationRequestSchema.parse({
      type: "bee.registration.request",
      bootstrapToken: "hp_boot_test",
      publicKey: "ed25519:abc",
      beeName: "bee-mini",
      daemonVersion: "0.1.0",
      hiveUrl: "https://hive.example.ts.net",
      labels: { role: "dev" },
      capabilities,
      requestedAt: "2026-05-08T20:00:00.000Z",
    });

    expect(parsed.capabilities.modelBackends).toContain("ollama");
    expect(parsed.capabilities.agentSessions?.[0]).toMatchObject({
      id: "hiveplane-task-task_123",
      runtime: "openclaw",
    });
    expect(parsed.capabilities.connectors?.[0]).toMatchObject({
      id: "github",
      status: "available",
    });
  });

  it("rejects an invalid hive URL", () => {
    expect(() =>
      BeeRegistrationRequestSchema.parse({
        type: "bee.registration.request",
        bootstrapToken: "hp_boot_test",
        publicKey: "ed25519:abc",
        beeName: "bee-mini",
        daemonVersion: "0.1.0",
        hiveUrl: "not-a-url",
        capabilities,
        requestedAt: "2026-05-08T20:00:00.000Z",
      }),
    ).toThrow();
  });

  it("accepts a pairing key in place of a bootstrap token", () => {
    const parsed = BeeRegistrationRequestSchema.parse({
      type: "bee.registration.request",
      pairingKey: "hp_pair_K7RQ2P9X",
      publicKey: "ed25519:abc",
      beeName: "bee-mini",
      daemonVersion: "0.1.0",
      hiveUrl: "https://hive.example.ts.net",
      capabilities,
      requestedAt: "2026-05-08T20:00:00.000Z",
    });
    expect(parsed.pairingKey).toBe("hp_pair_K7RQ2P9X");
    expect(parsed.bootstrapToken).toBeUndefined();
  });

  it("rejects a registration that supplies neither bootstrap token nor pairing key", () => {
    expect(() =>
      BeeRegistrationRequestSchema.parse({
        type: "bee.registration.request",
        publicKey: "ed25519:abc",
        beeName: "bee-mini",
        daemonVersion: "0.1.0",
        hiveUrl: "https://hive.example.ts.net",
        capabilities,
        requestedAt: "2026-05-08T20:00:00.000Z",
      }),
    ).toThrow(/exactly one/);
  });

  it("rejects a registration that supplies BOTH bootstrap token and pairing key", () => {
    expect(() =>
      BeeRegistrationRequestSchema.parse({
        type: "bee.registration.request",
        bootstrapToken: "hp_boot_test",
        pairingKey: "hp_pair_K7RQ2P9X",
        publicKey: "ed25519:abc",
        beeName: "bee-mini",
        daemonVersion: "0.1.0",
        hiveUrl: "https://hive.example.ts.net",
        capabilities,
        requestedAt: "2026-05-08T20:00:00.000Z",
      }),
    ).toThrow(/exactly one/);
  });
});

describe("heartbeat", () => {
  it("validates bee heartbeat payloads", () => {
    const heartbeat = BeeHeartbeatSchema.parse({
      type: "bee.heartbeat",
      beeId: "bee_123",
      timestamp: "2026-05-08T20:00:00.000Z",
      daemonVersion: "0.1.0",
      status: "online",
      activeJobs: 0,
      capabilities,
      permissions: { runCommand: { allow: ["hostname"], unsafeAllowAll: false } },
    });

    expect(heartbeat.status).toBe("online");
    expect(heartbeat.permissions?.runCommand.allow).toContain("hostname");
  });

  it("validates rescue heartbeat payloads", () => {
    const heartbeat = RescueHeartbeatSchema.parse({
      type: "rescue.heartbeat",
      beeId: "bee_123",
      timestamp: "2026-05-08T20:00:00.000Z",
      rescueVersion: "0.1.0",
      status: "online",
      capabilities: {
        actions: [
          "restart_bee",
          "update_bee",
          "collect_bee_logs",
          "diagnose_incident",
          "restart_openclaw_gateway",
          "restart_hermes_gateway",
          "repair_imessage_bridge",
        ],
        hardware: capabilities.hardware,
      },
    });

    expect(heartbeat.capabilities.actions).toContain("restart_bee");
  });
});

describe("jobs and events", () => {
  it("validates jobs and event batches", () => {
    const job = JobSchema.parse({
      id: "job_123",
      type: "run_command",
      beeId: "bee_123",
      status: "queued",
      payload: { command: "echo hello" },
      createdAt: "2026-05-08T20:00:00.000Z",
    });

    const batch = JobEventBatchSchema.parse({
      type: "job.events.append",
      jobId: job.id,
      beeId: job.beeId,
      events: [
        {
          id: "evt_1",
          jobId: job.id,
          beeId: job.beeId,
          sequence: 0,
          type: "job.started",
          level: "info",
          actor: "bee",
          data: { message: "started" },
          createdAt: "2026-05-08T20:00:01.000Z",
        },
      ],
    });

    expect(batch.events).toHaveLength(1);
  });

  it("validates adapter jobs", () => {
    for (const type of [
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
    ]) {
      const job = JobSchema.parse({
        id: `job_${type}`,
        type,
        beeId: "bee_123",
        status: "queued",
        payload: {},
        createdAt: "2026-05-08T20:00:00.000Z",
      });
      expect(job.type).toBe(type);
    }
  });
});

describe("approvals and wire messages", () => {
  it("validates approval requests", () => {
    const approval = ApprovalRequestSchema.parse({
      type: "approval.request",
      approvalId: "apv_123",
      jobId: "job_123",
      beeId: "bee_123",
      risk: "write",
      summary: "Install OpenClaw",
      action: "install_runtime",
      input: { runtime: "openclaw" },
      requestedAt: "2026-05-08T20:00:00.000Z",
    });

    expect(approval.risk).toBe("write");
  });

  it("validates Hive-to-Bee assignment messages", () => {
    const message = HiveToBeeMessageSchema.parse({
      type: "job.assign",
      job: {
        id: "job_123",
        type: "run_command",
        beeId: "bee_123",
        status: "assigned",
        payload: { command: "echo hello" },
        createdAt: "2026-05-08T20:00:00.000Z",
      },
    });

    expect(message.type).toBe("job.assign");
  });
});
