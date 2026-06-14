import { once } from "node:events";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createHiveServer, createHiveServerState, upsertBeeHeartbeat } from "./server.js";
import { createJob } from "./jobs.js";

async function withServer<T>(
  options: Parameters<typeof createHiveServer>[0],
  fn: (baseUrl: string) => Promise<T>,
): Promise<T> {
  const server = createHiveServer(options);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const address = server.address();
    if (!address || typeof address !== "object")
      throw new Error("server did not bind to a TCP port");
    return await fn(`http://127.0.0.1:${address.port}`);
  } finally {
    server.close();
  }
}

describe("Hive heartbeat state", () => {
  it("records first and latest Bee heartbeats", () => {
    const state = createHiveServerState();

    upsertBeeHeartbeat(state, {
      type: "bee.heartbeat",
      beeId: "bee_one",
      timestamp: "2026-05-09T20:00:00.000Z",
      daemonVersion: "0.0.1",
      status: "online",
      activeJobs: 0,
      capabilities: {
        runtimes: ["openclaw"],
        modelBackends: ["ollama"],
        models: ["gemma4:12b"],
        tools: ["openclaw"],
        networking: ["tailscale"],
        hardware: {
          platform: "darwin-arm64",
          hostname: "bee-one",
          cpuCores: 10,
          memoryGb: 32,
        },
      },
      permissions: { runCommand: { allow: ["hostname"], unsafeAllowAll: false } },
      healthChecks: [],
    });
    const latest = upsertBeeHeartbeat(state, {
      type: "bee.heartbeat",
      beeId: "bee_one",
      timestamp: "2026-05-09T20:01:00.000Z",
      daemonVersion: "0.0.1",
      status: "degraded",
      activeJobs: 1,
      permissions: { runCommand: { allow: ["hostname", "df"], unsafeAllowAll: false } },
      healthChecks: [
        {
          name: "openclaw-gateway",
          status: "failing",
          checkedAt: "2026-05-09T20:01:00.000Z",
          message: "gateway stopped",
        },
      ],
    });

    expect(latest).toMatchObject({
      beeId: "bee_one",
      firstSeenAt: "2026-05-09T20:00:00.000Z",
      lastSeenAt: "2026-05-09T20:01:00.000Z",
      heartbeatCount: 2,
      status: "degraded",
      activeJobs: 1,
      capabilities: expect.objectContaining({ runtimes: ["openclaw"] }),
      permissions: { runCommand: { allow: ["hostname", "df"], unsafeAllowAll: false } },
      healthChecks: [expect.objectContaining({ name: "openclaw-gateway", status: "failing" })],
    });
  });
});

describe("Hive server", () => {
  it("accepts heartbeat posts and lists connected Bees", async () => {
    const server = createHiveServer();
    server.listen(0, "127.0.0.1");
    await once(server, "listening");

    try {
      const address = server.address();
      if (!address || typeof address !== "object")
        throw new Error("server did not bind to a TCP port");
      const baseUrl = `http://127.0.0.1:${address.port}`;

      const heartbeatResponse = await fetch(`${baseUrl}/api/bees/heartbeat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          type: "bee.heartbeat",
          beeId: "bee_two",
          timestamp: "2026-05-09T20:02:00.000Z",
          daemonVersion: "0.0.1",
          status: "online",
          activeJobs: 0,
        }),
      });
      expect(heartbeatResponse.status).toBe(200);

      const beesResponse = await fetch(`${baseUrl}/api/bees`);
      const body = (await beesResponse.json()) as { bees: Array<{ beeId: string }> };
      expect(body.bees).toEqual([expect.objectContaining({ beeId: "bee_two" })]);
    } finally {
      server.close();
    }
  });

  it("records Rescue heartbeats and only assigns recovery-safe jobs to Rescue", async () => {
    const state = createHiveServerState();
    upsertBeeHeartbeat(state, {
      type: "bee.heartbeat",
      beeId: "bee_rescue",
      timestamp: "2026-05-09T20:02:00.000Z",
      daemonVersion: "0.0.1",
      status: "offline",
      activeJobs: 0,
      healthChecks: [],
    });
    const restartJob = createJob(
      state.jobsState,
      "bee_rescue",
      { type: "restart_bee", payload: {} },
      new Date("2026-05-09T20:02:01.000Z"),
    );
    const shellJob = createJob(
      state.jobsState,
      "bee_rescue",
      { type: "run_command", payload: { command: "hostname" } },
      new Date("2026-05-09T20:02:02.000Z"),
    );

    await withServer(
      { state, now: () => new Date("2026-05-09T20:02:04.000Z") },
      async (baseUrl) => {
        const response = await fetch(`${baseUrl}/api/rescue/heartbeat`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            type: "rescue.heartbeat",
            beeId: "bee_rescue",
            timestamp: "2026-05-09T20:02:03.000Z",
            rescueVersion: "0.0.7",
            status: "online",
            capabilities: {
              actions: ["restart_bee", "update_bee", "collect_bee_logs"],
              hardware: {
                platform: "darwin-arm64",
                hostname: "bee-rescue",
                cpuCores: 10,
                memoryGb: 32,
              },
            },
          }),
        });
        expect(response.status).toBe(200);
        const body = (await response.json()) as { jobs: Array<{ id: string; type: string }> };
        expect(body.jobs).toEqual([expect.objectContaining({ id: restartJob.id })]);
        expect(state.jobsState.jobs.get(restartJob.id)?.status).toBe("assigned");
        expect(state.jobsState.jobs.get(shellJob.id)?.status).toBe("queued");

        const bees = (await (await fetch(`${baseUrl}/api/bees`)).json()) as {
          bees: Array<{ beeId: string; rescue?: { status: string; rescueVersion: string } }>;
        };
        expect(bees.bees[0]).toMatchObject({
          beeId: "bee_rescue",
          rescue: { status: "online", rescueVersion: "0.0.7" },
        });

        const beeHeartbeat = await fetch(`${baseUrl}/api/bees/heartbeat`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            type: "bee.heartbeat",
            beeId: "bee_rescue",
            timestamp: "2026-05-09T20:02:05.000Z",
            daemonVersion: "0.0.7",
            status: "online",
            activeJobs: 0,
            healthChecks: [],
          }),
        });
        expect(beeHeartbeat.status).toBe(200);
        const afterBeeHeartbeat = (await (await fetch(`${baseUrl}/api/bees`)).json()) as {
          bees: Array<{ beeId: string; rescue?: { status: string; rescueVersion: string } }>;
        };
        expect(afterBeeHeartbeat.bees[0]?.rescue).toMatchObject({
          status: "online",
          rescueVersion: "0.0.7",
        });
      },
    );
  });

  it("classifies intermittent Bees as expected offline during their grace window", async () => {
    const state = createHiveServerState();
    const bee = upsertBeeHeartbeat(state, {
      type: "bee.heartbeat",
      beeId: "bee_laptop",
      timestamp: "2026-05-09T08:00:00.000Z",
      daemonVersion: "0.0.7",
      status: "online",
      activeJobs: 0,
      healthChecks: [],
    });
    bee.profile = {
      availabilityClass: "intermittent",
      offlineGraceSeconds: 12 * 60 * 60,
      expectedWindows: [],
      criticalServices: [],
      activeJobPolicy: "escalate",
      autoRepairWhenOnline: true,
    };

    await withServer(
      { state, now: () => new Date("2026-05-09T12:00:00.000Z") },
      async (baseUrl) => {
        const body = (await (await fetch(`${baseUrl}/api/bees`)).json()) as {
          bees: Array<{ beeId: string; status: string; operationalState: string }>;
          incidents: unknown[];
        };

        expect(body.bees).toEqual([
          expect.objectContaining({
            beeId: "bee_laptop",
            status: "offline",
            operationalState: "expected_offline",
          }),
        ]);
        expect(body.incidents).toEqual([]);
      },
    );
  });

  it("honors short offline grace windows before the default stale threshold", async () => {
    const state = createHiveServerState();
    const bee = upsertBeeHeartbeat(state, {
      type: "bee.heartbeat",
      beeId: "bee_short_grace",
      timestamp: "2026-05-09T08:00:00.000Z",
      daemonVersion: "0.0.7",
      status: "online",
      activeJobs: 0,
      healthChecks: [],
    });
    bee.profile = {
      availabilityClass: "critical",
      offlineGraceSeconds: 30,
      expectedWindows: [],
      criticalServices: [],
      activeJobPolicy: "escalate",
      autoRepairWhenOnline: true,
    };

    await withServer(
      { state, now: () => new Date("2026-05-09T08:00:45.000Z") },
      async (baseUrl) => {
        const body = (await (await fetch(`${baseUrl}/api/bees`)).json()) as {
          bees: Array<{ beeId: string; status: string; operationalState: string }>;
        };

        expect(body.bees[0]).toMatchObject({
          beeId: "bee_short_grace",
          status: "offline",
          operationalState: "unresolved_incident",
        });
      },
    );
  });

  it("queues a safe Rescue recovery job when an always-on Bee is stale", async () => {
    const state = createHiveServerState();
    upsertBeeHeartbeat(state, {
      type: "bee.heartbeat",
      beeId: "bee_server",
      timestamp: "2026-05-09T08:00:00.000Z",
      daemonVersion: "0.0.7",
      status: "online",
      activeJobs: 0,
      healthChecks: [],
    });

    await withServer(
      { state, now: () => new Date("2026-05-09T08:10:00.000Z") },
      async (baseUrl) => {
        const response = await fetch(`${baseUrl}/api/rescue/heartbeat`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            type: "rescue.heartbeat",
            beeId: "bee_server",
            timestamp: "2026-05-09T08:10:00.000Z",
            rescueVersion: "0.0.7",
            status: "online",
            capabilities: {
              actions: ["restart_bee", "collect_bee_logs"],
              hardware: {
                platform: "darwin-arm64",
                hostname: "bee-server",
                cpuCores: 10,
                memoryGb: 32,
              },
            },
          }),
        });

        expect(response.status).toBe(200);
        const rescueBody = (await response.json()) as {
          jobs: Array<{ id: string; type: string; payload: { incidentId?: string } }>;
        };
        expect(rescueBody.jobs).toEqual([
          expect.objectContaining({
            type: "diagnose_incident",
            payload: expect.objectContaining({ incidentId: "bee_server:bee_offline" }),
          }),
          expect.objectContaining({
            type: "restart_bee",
            payload: { incidentId: "bee_server:bee_offline" },
          }),
        ]);

        const body = (await (await fetch(`${baseUrl}/api/bees`)).json()) as {
          bees: Array<{ beeId: string; operationalState: string }>;
          incidents: Array<{ id: string; status: string; attempts: unknown[] }>;
        };
        expect(body.bees[0]).toMatchObject({
          beeId: "bee_server",
          operationalState: "recovering",
        });
        expect(body.incidents[0]).toMatchObject({
          id: "bee_server:bee_offline",
          status: "recovering",
        });
        expect(body.incidents[0]?.attempts).toHaveLength(1);
      },
    );
  });

  it("creates Hive tasks and assigns them to matching healthy Bees", async () => {
    const state = createHiveServerState();
    upsertBeeHeartbeat(state, {
      type: "bee.heartbeat",
      beeId: "bee_agent",
      timestamp: "2026-05-09T08:00:00.000Z",
      daemonVersion: "0.0.7",
      status: "online",
      activeJobs: 0,
      capabilities: {
        runtimes: ["openclaw"],
        modelBackends: ["ollama"],
        models: ["gemma4:12b"],
        tools: ["github", "filesystem"],
        networking: ["tailscale"],
        hardware: {
          platform: "darwin-arm64",
          hostname: "bee-agent",
          cpuCores: 10,
          memoryGb: 32,
        },
      },
      healthChecks: [],
    });

    await withServer(
      { state, adminToken: "secret", now: () => new Date("2026-05-09T08:00:05.000Z") },
      async (baseUrl) => {
        const response = await fetch(`${baseUrl}/api/tasks`, {
          method: "POST",
          headers: { authorization: "Bearer secret", "content-type": "application/json" },
          body: JSON.stringify({
            title: "Summarize repo",
            instructions: "Inspect the repo and report the next task.",
            requestedBy: "Austin",
            requirements: { runtimes: ["openclaw"], tools: ["github"] },
          }),
        });

        expect(response.status).toBe(200);
        const body = (await response.json()) as {
          task: { id: string; status: string; assignedBeeId: string; jobId: string };
        };
        expect(body.task).toMatchObject({
          status: "assigned",
          assignedBeeId: "bee_agent",
        });

        const jobs = (await (
          await fetch(`${baseUrl}/api/jobs`, {
            headers: { authorization: "Bearer secret" },
          })
        ).json()) as { jobs: Array<{ id: string; type: string; payload: { taskId?: string } }> };
        expect(jobs.jobs[0]).toMatchObject({
          id: body.task.jobId,
          type: "agent_task",
          payload: { taskId: expect.any(String) },
        });

        const eventResponse = await fetch(`${baseUrl}/api/jobs/${body.task.jobId}/events`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            type: "job.events.append",
            jobId: body.task.jobId,
            beeId: "bee_agent",
            events: [
              {
                id: "evt_task_running",
                jobId: body.task.jobId,
                beeId: "bee_agent",
                sequence: 1,
                type: "agent_task.openclaw.start",
                level: "info",
                actor: "bee",
                data: { text: "starting OpenClaw task" },
                createdAt: "2026-05-09T08:00:06.000Z",
              },
            ],
          }),
        });
        expect(eventResponse.status).toBe(200);

        const tasksBody = (await (
          await fetch(`${baseUrl}/api/tasks`, {
            headers: { authorization: "Bearer secret" },
          })
        ).json()) as { tasks: Array<{ id: string; status: string; jobId: string }> };
        const task = tasksBody.tasks[0];
        expect(task).toBeDefined();
        if (!task) throw new Error("expected created task");
        expect(task).toMatchObject({ status: "running", jobId: body.task.jobId });

        const detailResponse = await fetch(`${baseUrl}/api/tasks/${body.task.id}`, {
          headers: { authorization: "Bearer secret" },
        });
        expect(detailResponse.status).toBe(200);
        const detail = (await detailResponse.json()) as {
          task: { id: string; status: string };
          job: { id: string; eventCount: number; events: Array<{ type: string }> };
        };
        expect(detail.task).toMatchObject({ id: task.id, status: "running" });
        expect(detail.job).toMatchObject({ id: body.task.jobId, eventCount: 1 });
        expect(detail.job.events[0]).toMatchObject({ type: "agent_task.openclaw.start" });
      },
    );
  });

  it("blocks Hive tasks when no healthy Bee matches requirements", async () => {
    const state = createHiveServerState();
    upsertBeeHeartbeat(state, {
      type: "bee.heartbeat",
      beeId: "bee_basic",
      timestamp: "2026-05-09T08:00:00.000Z",
      daemonVersion: "0.0.7",
      status: "online",
      activeJobs: 0,
      capabilities: {
        runtimes: ["openclaw"],
        modelBackends: [],
        models: [],
        tools: ["filesystem"],
        networking: [],
        hardware: {
          platform: "darwin-arm64",
          hostname: "bee-basic",
          cpuCores: 10,
          memoryGb: 32,
        },
      },
      healthChecks: [],
    });

    await withServer(
      { state, adminToken: "secret", now: () => new Date("2026-05-09T08:00:05.000Z") },
      async (baseUrl) => {
        const response = await fetch(`${baseUrl}/api/tasks`, {
          method: "POST",
          headers: { authorization: "Bearer secret", "content-type": "application/json" },
          body: JSON.stringify({
            title: "Run model task",
            instructions: "Use a local model.",
            requirements: { models: ["gemma4:12b"] },
          }),
        });

        expect(response.status).toBe(200);
        const body = (await response.json()) as {
          task: { id: string; status: string; lastError: string };
        };
        expect(body.task).toMatchObject({
          status: "blocked",
          lastError: "No healthy Bee currently matches the task requirements.",
        });

        upsertBeeHeartbeat(state, {
          type: "bee.heartbeat",
          beeId: "bee_model",
          timestamp: "2026-05-09T08:00:10.000Z",
          daemonVersion: "0.0.7",
          status: "online",
          activeJobs: 0,
          capabilities: {
            runtimes: ["openclaw"],
            modelBackends: ["ollama"],
            models: ["gemma4:12b"],
            tools: ["filesystem"],
            networking: [],
            hardware: {
              platform: "darwin-arm64",
              hostname: "bee-model",
              cpuCores: 10,
              memoryGb: 32,
            },
          },
          healthChecks: [],
        });

        const retryResponse = await fetch(`${baseUrl}/api/tasks/${body.task.id}/retry`, {
          method: "POST",
          headers: { authorization: "Bearer secret" },
        });
        expect(retryResponse.status).toBe(200);
        const retryBody = (await retryResponse.json()) as {
          task: { status: string; assignedBeeId: string; jobId: string };
        };
        expect(retryBody.task).toMatchObject({
          status: "assigned",
          assignedBeeId: "bee_model",
          jobId: expect.stringMatching(/^job_/),
        });
      },
    );
  });

  it("verifies a successful repair before resolving an incident", async () => {
    const state = createHiveServerState();
    upsertBeeHeartbeat(state, {
      type: "bee.heartbeat",
      beeId: "bee_verify",
      timestamp: "2026-05-09T08:00:00.000Z",
      daemonVersion: "0.0.7",
      status: "online",
      activeJobs: 0,
      healthChecks: [],
    });

    await withServer(
      { state, now: () => new Date("2026-05-09T08:10:00.000Z") },
      async (baseUrl) => {
        const rescueResponse = await fetch(`${baseUrl}/api/rescue/heartbeat`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            type: "rescue.heartbeat",
            beeId: "bee_verify",
            timestamp: "2026-05-09T08:10:00.000Z",
            rescueVersion: "0.0.7",
            status: "online",
            capabilities: {
              actions: ["restart_bee", "collect_bee_logs"],
              hardware: {
                platform: "darwin-arm64",
                hostname: "bee-verify",
                cpuCores: 10,
                memoryGb: 32,
              },
            },
          }),
        });
        const rescueBody = (await rescueResponse.json()) as {
          jobs: Array<{ id: string; type: string }>;
        };
        const repairJob = rescueBody.jobs.find((job) => job.type === "restart_bee");
        expect(repairJob).toBeDefined();

        const repairComplete = await fetch(`${baseUrl}/api/jobs/${repairJob?.id}/complete`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            type: "job.complete",
            jobId: repairJob?.id,
            beeId: "bee_verify",
            status: "succeeded",
            output: { restarted: true },
            completedAt: "2026-05-09T08:10:05.000Z",
          }),
        });
        expect(repairComplete.status).toBe(200);

        let body = (await (await fetch(`${baseUrl}/api/bees`)).json()) as {
          incidents: Array<{
            status: string;
            verification?: { jobId: string; status?: string };
          }>;
        };
        expect(body.incidents[0]).toMatchObject({
          status: "recovering",
          verification: expect.objectContaining({ jobId: expect.any(String) }),
        });
        expect(body.incidents[0]?.verification?.status).toBeUndefined();

        const beeHeartbeat = await fetch(`${baseUrl}/api/bees/heartbeat`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            type: "bee.heartbeat",
            beeId: "bee_verify",
            timestamp: "2026-05-09T08:10:10.000Z",
            daemonVersion: "0.0.7",
            status: "online",
            activeJobs: 0,
            healthChecks: [],
          }),
        });
        const beeBody = (await beeHeartbeat.json()) as {
          jobs: Array<{ id: string; type: string; payload: { incidentId?: string } }>;
        };
        const verificationJob = beeBody.jobs.find((job) => job.type === "run_healthcheck");
        expect(verificationJob).toBeDefined();
        body = (await (await fetch(`${baseUrl}/api/bees`)).json()) as typeof body;
        expect(body.incidents[0]?.status).toBe("recovering");

        const verificationComplete = await fetch(
          `${baseUrl}/api/jobs/${verificationJob?.id}/complete`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              type: "job.complete",
              jobId: verificationJob?.id,
              beeId: "bee_verify",
              status: "succeeded",
              output: { ok: true },
              completedAt: "2026-05-09T08:10:15.000Z",
            }),
          },
        );
        expect(verificationComplete.status).toBe(200);

        await fetch(`${baseUrl}/api/bees/heartbeat`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            type: "bee.heartbeat",
            beeId: "bee_verify",
            timestamp: "2026-05-09T08:10:20.000Z",
            daemonVersion: "0.0.7",
            status: "online",
            activeJobs: 0,
            healthChecks: [],
          }),
        });

        body = (await (await fetch(`${baseUrl}/api/bees`)).json()) as typeof body;
        expect(body.incidents[0]).toMatchObject({
          status: "resolved",
          verification: expect.objectContaining({ status: "succeeded" }),
        });
      },
    );
  });

  it("dedupes incident notifications for approval-required failures", async () => {
    const state = createHiveServerState();

    await withServer(
      { state, now: () => new Date("2026-05-09T08:00:00.000Z") },
      async (baseUrl) => {
        const heartbeat = {
          type: "bee.heartbeat",
          beeId: "bee_notify",
          timestamp: "2026-05-09T08:00:00.000Z",
          daemonVersion: "0.0.7",
          status: "degraded",
          activeJobs: 0,
          healthChecks: [
            {
              name: "unknown-ai-runtime",
              status: "failing",
              checkedAt: "2026-05-09T08:00:00.000Z",
              message: "runtime not responding",
            },
          ],
        };

        for (let i = 0; i < 2; i += 1) {
          const response = await fetch(`${baseUrl}/api/bees/heartbeat`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(heartbeat),
          });
          expect(response.status).toBe(200);
        }

        const body = (await (await fetch(`${baseUrl}/api/bees`)).json()) as {
          incidents: Array<{
            status: string;
            notifications: Array<{ status: string; deliveryStatus: string }>;
          }>;
        };
        expect(body.incidents[0]).toMatchObject({
          status: "needs_approval",
          notifications: [{ status: "needs_approval", deliveryStatus: "queued" }],
        });
      },
    );
  });

  it("delivers queued incident notifications through the configured notifier", async () => {
    const state = createHiveServerState();
    const deliveries: unknown[] = [];

    await withServer(
      {
        state,
        now: () => new Date("2026-05-09T08:00:00.000Z"),
        incidentNotifier: {
          channel: "test",
          deliver: async (payload) => {
            deliveries.push(payload);
          },
        },
      },
      async (baseUrl) => {
        const response = await fetch(`${baseUrl}/api/bees/heartbeat`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            type: "bee.heartbeat",
            beeId: "bee_deliver",
            timestamp: "2026-05-09T08:00:00.000Z",
            daemonVersion: "0.0.7",
            status: "degraded",
            activeJobs: 0,
            healthChecks: [
              {
                name: "unknown-ai-runtime",
                status: "failing",
                checkedAt: "2026-05-09T08:00:00.000Z",
                message: "runtime not responding",
              },
            ],
          }),
        });
        expect(response.status).toBe(200);
        expect(deliveries).toHaveLength(1);

        const body = (await (await fetch(`${baseUrl}/api/bees`)).json()) as {
          incidents: Array<{
            notifications: Array<{
              status: string;
              deliveryStatus: string;
              deliveryChannel: string;
              deliveryAttempts: number;
              deliveredAt: string;
            }>;
          }>;
        };
        expect(body.incidents[0]?.notifications[0]).toMatchObject({
          status: "needs_approval",
          deliveryStatus: "sent",
          deliveryChannel: "test",
          deliveryAttempts: 1,
          deliveredAt: "2026-05-09T08:00:00.000Z",
        });
      },
    );
  });

  it("lets an admin update a Bee availability profile", async () => {
    const state = createHiveServerState();
    upsertBeeHeartbeat(state, {
      type: "bee.heartbeat",
      beeId: "bee_profile",
      timestamp: "2026-05-09T08:00:00.000Z",
      daemonVersion: "0.0.7",
      status: "online",
      activeJobs: 0,
      healthChecks: [],
    });

    await withServer({ state, adminToken: "secret" }, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/bees/bee_profile/profile`, {
        method: "PATCH",
        headers: { authorization: "Bearer secret", "content-type": "application/json" },
        body: JSON.stringify({
          availabilityClass: "critical",
          offlineGraceSeconds: 60,
          criticalServices: ["openclaw-gateway"],
        }),
      });

      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        warnings: string[];
        bee: {
          profile: {
            availabilityClass: string;
            offlineGraceSeconds: number;
            criticalServices: string[];
          };
        };
      };
      expect(body.bee.profile).toMatchObject({
        availabilityClass: "critical",
        offlineGraceSeconds: 60,
        criticalServices: ["openclaw-gateway"],
      });
      expect(body.warnings).toEqual([]);
    });
  });

  it("rejects invalid Bee profile patches", async () => {
    const state = createHiveServerState();
    upsertBeeHeartbeat(state, {
      type: "bee.heartbeat",
      beeId: "bee_bad_profile",
      timestamp: "2026-05-09T08:00:00.000Z",
      daemonVersion: "0.0.7",
      status: "online",
      activeJobs: 0,
      healthChecks: [],
    });

    await withServer({ state, adminToken: "secret" }, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/bees/bee_bad_profile/profile`, {
        method: "PATCH",
        headers: { authorization: "Bearer secret", "content-type": "application/json" },
        body: JSON.stringify({
          availabilityClass: "critical",
          offlineGraceSeconds: 0,
        }),
      });

      expect(response.status).toBe(400);
      const body = (await response.json()) as { error: string; reason: string };
      expect(body).toMatchObject({
        error: "bad_request",
        reason: "offlineGraceSeconds must be an integer from 30 seconds to 7 days",
      });
    });
  });

  it("returns warnings for risky Bee profile combinations", async () => {
    const state = createHiveServerState();
    upsertBeeHeartbeat(state, {
      type: "bee.heartbeat",
      beeId: "bee_warn_profile",
      timestamp: "2026-05-09T08:00:00.000Z",
      daemonVersion: "0.0.7",
      status: "online",
      activeJobs: 0,
      healthChecks: [],
    });

    await withServer({ state, adminToken: "secret" }, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/bees/bee_warn_profile/profile`, {
        method: "PATCH",
        headers: { authorization: "Bearer secret", "content-type": "application/json" },
        body: JSON.stringify({
          availabilityClass: "critical",
          offlineGraceSeconds: 3600,
          autoRepairWhenOnline: false,
          criticalServices: [],
        }),
      });

      expect(response.status).toBe(200);
      const body = (await response.json()) as { warnings: string[] };
      expect(body.warnings).toEqual(
        expect.arrayContaining([
          "Always-on and critical Bees usually need a grace window under 10 minutes.",
          "Critical Bees default to a 60 second grace window.",
          "Auto repair is disabled, so server-like Bees will alert instead of self-heal.",
          "Critical profiles are more useful when at least one critical service is set.",
        ]),
      );
    });
  });

  it("admin can delete a stale Bee and its sessions", async () => {
    const state = createHiveServerState();
    const bee = upsertBeeHeartbeat(state, {
      type: "bee.heartbeat",
      beeId: "bee_stale",
      timestamp: "2026-05-09T20:02:00.000Z",
      daemonVersion: "0.0.1",
      status: "online",
      activeJobs: 0,
      healthChecks: [],
    });
    state.sessions.set("token-hash", {
      sessionId: "sess_test",
      beeId: bee.beeId,
      tokenHash: "token-hash",
      expiresAt: new Date("2026-06-01T00:00:00.000Z"),
      createdAt: new Date("2026-05-09T20:02:00.000Z"),
    });

    await withServer({ state, adminToken: "secret" }, async (baseUrl) => {
      const noAuth = await fetch(`${baseUrl}/api/bees/${bee.beeId}`, { method: "DELETE" });
      expect(noAuth.status).toBe(401);

      const deleted = await fetch(`${baseUrl}/api/bees/${bee.beeId}`, {
        method: "DELETE",
        headers: { authorization: "Bearer secret" },
      });
      expect(deleted.status).toBe(200);
      expect(state.bees.has(bee.beeId)).toBe(false);
      expect(state.sessions.size).toBe(0);

      const missing = await fetch(`${baseUrl}/api/bees/${bee.beeId}`, {
        method: "DELETE",
        headers: { authorization: "Bearer secret" },
      });
      expect(missing.status).toBe(404);
    });
  });

  it("serves install scripts and 404s on unknown ones", async () => {
    const installDir = mkdtempSync(join(tmpdir(), "hiveplane-install-test-"));
    writeFileSync(join(installDir, "bee.sh"), "#!/bin/sh\necho hi from bee installer\n");
    writeFileSync(join(installDir, "hive.sh"), "#!/bin/sh\necho hi from hive installer\n");

    const server = createHiveServer({ installScriptsDir: installDir });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");

    try {
      const address = server.address();
      if (!address || typeof address !== "object")
        throw new Error("server did not bind to a TCP port");
      const baseUrl = `http://127.0.0.1:${address.port}`;

      const beeRes = await fetch(`${baseUrl}/install/bee.sh`);
      expect(beeRes.status).toBe(200);
      expect(beeRes.headers.get("content-type")).toContain("text/x-shellscript");
      expect(await beeRes.text()).toContain("hi from bee installer");

      const hiveRes = await fetch(`${baseUrl}/install/hive.sh`);
      expect(hiveRes.status).toBe(200);
      expect(await hiveRes.text()).toContain("hi from hive installer");

      const wrongRes = await fetch(`${baseUrl}/install/evil.sh`);
      expect(wrongRes.status).toBe(404);
    } finally {
      server.close();
    }
  });

  it("serves the dashboard at /, /dashboard, and /index.html", async () => {
    const publicDir = mkdtempSync(join(tmpdir(), "hiveplane-public-test-"));
    writeFileSync(join(publicDir, "index.html"), "<!doctype html><title>Test Dashboard</title>");

    const server = createHiveServer({ publicDir });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");

    try {
      const address = server.address();
      if (!address || typeof address !== "object")
        throw new Error("server did not bind to a TCP port");
      const baseUrl = `http://127.0.0.1:${address.port}`;

      for (const path of ["/", "/dashboard", "/dashboard/", "/index.html"]) {
        const ok = await fetch(`${baseUrl}${path}`);
        expect(ok.status, `path ${path}`).toBe(200);
        expect(ok.headers.get("content-type")).toContain("text/html");
        expect(await ok.text()).toContain("Test Dashboard");
      }
    } finally {
      server.close();
    }

    // Now point at an empty dir → 404 with the helpful error.
    const emptyDir = mkdtempSync(join(tmpdir(), "hiveplane-empty-test-"));
    const server2 = createHiveServer({ publicDir: emptyDir });
    server2.listen(0, "127.0.0.1");
    await once(server2, "listening");

    try {
      const address = server2.address();
      if (!address || typeof address !== "object")
        throw new Error("server did not bind to a TCP port");
      const res = await fetch(`http://127.0.0.1:${address.port}/`);
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe("dashboard_not_built");
    } finally {
      server2.close();
    }
  });

  it("/healthz and /version include the running version", async () => {
    const server = createHiveServer();
    server.listen(0, "127.0.0.1");
    await once(server, "listening");

    try {
      const address = server.address();
      if (!address || typeof address !== "object")
        throw new Error("server did not bind to a TCP port");
      const baseUrl = `http://127.0.0.1:${address.port}`;

      const healthz = await fetch(`${baseUrl}/healthz`);
      const healthzBody = (await healthz.json()) as { ok: boolean; version: string };
      expect(healthzBody.ok).toBe(true);
      expect(healthzBody.version).toMatch(/^\d+\.\d+\.\d+/);

      const version = await fetch(`${baseUrl}/version`);
      const versionBody = (await version.json()) as { version: string; service: string };
      expect(versionBody.service).toBe("hiveplane-hive");
      expect(versionBody.version).toBe(healthzBody.version);
    } finally {
      server.close();
    }
  });
});
