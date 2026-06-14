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

describe("audit log", () => {
  it("records admin mutations with actor and resource context", async () => {
    const state = createHiveServerState();

    await withServer({ state, adminToken: "secret" }, async (baseUrl) => {
      const created = await fetch(`${baseUrl}/api/bootstrap-tokens`, {
        method: "POST",
        headers: {
          authorization: "Bearer secret",
          "content-type": "application/json",
          "x-hiveplane-actor": "austin@example.com",
        },
        body: JSON.stringify({ beeName: "new-laptop" }),
      });
      expect(created.status).toBe(200);
      const token = (await created.json()) as { tokenId: string };

      const auditRes = await fetch(`${baseUrl}/api/audit-log`, {
        headers: { authorization: "Bearer secret" },
      });
      expect(auditRes.status).toBe(200);
      const { entries } = (await auditRes.json()) as { entries: Array<Record<string, unknown>> };
      expect(entries[0]).toMatchObject({
        actorType: "user",
        actorId: "austin@example.com",
        action: "bootstrap_token.create",
        resourceType: "bootstrap_token",
        resourceId: token.tokenId,
      });
    });
  });
});

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
        localModels: [
          {
            backend: "ollama",
            name: "gemma4:12b",
            endpointUrl: "http://127.0.0.1:11434",
            resourceHints: {},
          },
        ],
        tools: ["openclaw"],
        networking: ["tailscale"],
        hardware: {
          platform: "darwin-arm64",
          hostname: "bee-one",
          cpuCores: 10,
          memoryGb: 32,
        },
      },
      permissions: {
        runCommand: { allow: ["hostname"], deny: [], requireApproval: [], unsafeAllowAll: false },
        jobs: { allow: [], deny: [], requireApproval: [] },
        connectors: { allow: ["filesystem"], deny: [], requireApproval: [] },
      },
      healthChecks: [],
    });
    const latest = upsertBeeHeartbeat(state, {
      type: "bee.heartbeat",
      beeId: "bee_one",
      timestamp: "2026-05-09T20:01:00.000Z",
      daemonVersion: "0.0.1",
      status: "degraded",
      activeJobs: 1,
      permissions: {
        runCommand: {
          allow: ["hostname", "df"],
          deny: [],
          requireApproval: [],
          unsafeAllowAll: false,
        },
        jobs: { allow: [], deny: [], requireApproval: [] },
        connectors: { allow: ["filesystem"], deny: [], requireApproval: [] },
      },
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
      permissionProfile: "personal_assistant",
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
      permissionProfile: "server_worker",
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
        localModels: [
          {
            backend: "ollama",
            name: "gemma4:12b",
            endpointUrl: "http://127.0.0.1:11434",
            resourceHints: {},
          },
        ],
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

  it("defines OpenClaw sub-agents and routes tasks only to Bees reporting them", async () => {
    const state = createHiveServerState();
    const capabilities = {
      runtimes: ["openclaw"],
      modelBackends: ["ollama"],
      models: ["gemma4:12b"],
      localModels: [
        {
          backend: "ollama",
          name: "gemma4:12b",
          endpointUrl: "http://127.0.0.1:11434",
          resourceHints: {},
        },
      ],
      tools: ["github", "filesystem"],
      networking: ["tailscale"],
      hardware: {
        platform: "darwin-arm64" as const,
        hostname: "bee-agent",
        cpuCores: 10,
        memoryGb: 32,
      },
    };
    upsertBeeHeartbeat(state, {
      type: "bee.heartbeat",
      beeId: "bee_agent",
      timestamp: "2026-05-09T08:00:00.000Z",
      daemonVersion: "0.0.7",
      status: "online",
      activeJobs: 0,
      capabilities,
      healthChecks: [],
    });

    await withServer(
      { state, adminToken: "secret", now: () => new Date("2026-05-09T08:00:05.000Z") },
      async (baseUrl) => {
        const created = await fetch(`${baseUrl}/api/sub-agents`, {
          method: "POST",
          headers: { authorization: "Bearer secret", "content-type": "application/json" },
          body: JSON.stringify({
            name: "Repo reviewer",
            runtime: "openclaw",
            systemId: "public",
            modelProvider: "ollama",
            model: "gemma4:12b",
            tools: ["github", "filesystem"],
            workingDirectories: ["/Users/chris/.hiveplane/install"],
            targetBeeIds: ["bee_agent"],
          }),
        });
        expect(created.status).toBe(200);
        const createdBody = (await created.json()) as {
          subAgent: { id: string; name: string; runtime: string };
        };
        expect(createdBody.subAgent).toMatchObject({ name: "Repo reviewer", runtime: "openclaw" });

        const reconcile = await fetch(
          `${baseUrl}/api/sub-agents/${createdBody.subAgent.id}/reconcile`,
          {
            method: "POST",
            headers: { authorization: "Bearer secret" },
          },
        );
        expect(reconcile.status).toBe(200);
        const reconcileBody = (await reconcile.json()) as {
          jobs: Array<{ type: string; status: string; payload: { id: string } }>;
        };
        expect(reconcileBody.jobs).toEqual([
          expect.objectContaining({
            type: "openclaw_subagent_configure",
            status: "waiting_for_approval",
            payload: expect.objectContaining({ id: createdBody.subAgent.id }),
          }),
        ]);

        const blocked = await fetch(`${baseUrl}/api/tasks`, {
          method: "POST",
          headers: { authorization: "Bearer secret", "content-type": "application/json" },
          body: JSON.stringify({
            title: "Review repo",
            instructions: "Find the risky code.",
            requestedSubAgentId: createdBody.subAgent.id,
            requirements: { runtimes: ["openclaw"], tools: ["github"] },
          }),
        });
        expect(blocked.status).toBe(200);
        const blockedBody = (await blocked.json()) as {
          task: { status: string; lastError: string };
        };
        expect(blockedBody.task).toMatchObject({
          status: "blocked",
          lastError: "No healthy Bee currently matches the task requirements.",
        });

        upsertBeeHeartbeat(state, {
          type: "bee.heartbeat",
          beeId: "bee_agent",
          timestamp: "2026-05-09T08:00:10.000Z",
          daemonVersion: "0.0.7",
          status: "online",
          activeJobs: 0,
          capabilities: {
            ...capabilities,
            subAgents: [
              {
                id: createdBody.subAgent.id,
                name: "Repo reviewer",
                runtime: "openclaw",
                status: "configured",
                systemId: "public",
                modelProvider: "ollama",
                model: "gemma4:12b",
                tools: ["github", "filesystem"],
                skills: [],
                workingDirectories: ["/Users/chris/.hiveplane/install"],
                updatedAt: "2026-05-09T08:00:10.000Z",
                metadata: {},
              },
            ],
          },
          healthChecks: [],
        });

        const assigned = await fetch(`${baseUrl}/api/tasks`, {
          method: "POST",
          headers: { authorization: "Bearer secret", "content-type": "application/json" },
          body: JSON.stringify({
            title: "Review repo again",
            instructions: "Find the risky code.",
            requestedSubAgentId: createdBody.subAgent.id,
            requirements: { runtimes: ["openclaw"], tools: ["github"] },
          }),
        });
        expect(assigned.status).toBe(200);
        const assignedBody = (await assigned.json()) as {
          task: { status: string; assignedBeeId: string; jobId: string };
        };
        expect(assignedBody.task).toMatchObject({
          status: "assigned",
          assignedBeeId: "bee_agent",
        });
        const jobs = (await (
          await fetch(`${baseUrl}/api/jobs`, { headers: { authorization: "Bearer secret" } })
        ).json()) as { jobs: Array<{ id: string; payload: { subAgentId?: string } }> };
        expect(jobs.jobs).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              id: assignedBody.task.jobId,
              payload: expect.objectContaining({ subAgentId: createdBody.subAgent.id }),
            }),
          ]),
        );
      },
    );
  });

  it("enforces operator run permissions and Bee system access for Hive tasks", async () => {
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
        modelBackends: [],
        models: [],
        localModels: [],
        tools: ["github"],
        networking: [],
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
        const operatorResponse = await fetch(`${baseUrl}/api/operators`, {
          method: "POST",
          headers: { authorization: "Bearer secret", "content-type": "application/json" },
          body: JSON.stringify({ email: "operator@example.com", role: "operator" }),
        });
        expect(operatorResponse.status).toBe(200);
        const operatorBody = (await operatorResponse.json()) as {
          token: string;
          operator: { userId: string };
        };

        const forbiddenTask = await fetch(`${baseUrl}/api/tasks`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${operatorBody.token}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            title: "Finance task",
            instructions: "Inspect finance files.",
            targetSystemId: "finance",
            requirements: { runtimes: ["openclaw"], tools: ["github"] },
          }),
        });
        expect(forbiddenTask.status).toBe(403);

        const grantResponse = await fetch(`${baseUrl}/api/system-permissions`, {
          method: "POST",
          headers: { authorization: "Bearer secret", "content-type": "application/json" },
          body: JSON.stringify({
            userId: operatorBody.operator.userId,
            systemId: "finance",
            permissions: ["run"],
          }),
        });
        expect(grantResponse.status).toBe(200);

        const blockedTask = await fetch(`${baseUrl}/api/tasks`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${operatorBody.token}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            title: "Finance task",
            instructions: "Inspect finance files.",
            targetSystemId: "finance",
            requirements: { runtimes: ["openclaw"], tools: ["github"] },
          }),
        });
        expect(blockedTask.status).toBe(200);
        const blockedBody = (await blockedTask.json()) as { task: { status: string } };
        expect(blockedBody.task.status).toBe("blocked");

        const beeGrant = await fetch(`${baseUrl}/api/bee-system-access`, {
          method: "POST",
          headers: { authorization: "Bearer secret", "content-type": "application/json" },
          body: JSON.stringify({
            beeId: "bee_agent",
            systemId: "finance",
            access: "limited",
          }),
        });
        expect(beeGrant.status).toBe(200);

        const assignedTask = await fetch(`${baseUrl}/api/tasks`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${operatorBody.token}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            title: "Finance task",
            instructions: "Inspect finance files.",
            targetSystemId: "finance",
            requirements: { runtimes: ["openclaw"], tools: ["github"] },
          }),
        });
        expect(assignedTask.status).toBe(200);
        const assignedBody = (await assignedTask.json()) as {
          task: { id: string; status: string; assignedBeeId: string };
        };
        expect(assignedBody.task).toMatchObject({
          status: "assigned",
          assignedBeeId: "bee_agent",
        });

        const visibleTasks = await fetch(`${baseUrl}/api/tasks`, {
          headers: { authorization: `Bearer ${operatorBody.token}` },
        });
        expect(visibleTasks.status).toBe(200);
        const visibleTasksBody = (await visibleTasks.json()) as {
          tasks: Array<{ id: string; targetSystemId: string }>;
        };
        expect(visibleTasksBody.tasks).toEqual(
          expect.arrayContaining([expect.objectContaining({ targetSystemId: "finance" })]),
        );

        const cancelledTask = await fetch(`${baseUrl}/api/tasks/${assignedBody.task.id}/cancel`, {
          method: "POST",
          headers: { authorization: `Bearer ${operatorBody.token}` },
        });
        expect(cancelledTask.status).toBe(200);

        const automationResponse = await fetch(`${baseUrl}/api/automations`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${operatorBody.token}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            title: "Finance automation",
            instructions: "Inspect finance files later.",
            targetSystemId: "finance",
            requirements: { runtimes: ["openclaw"], tools: ["github"] },
            trigger: "interval",
            everySeconds: 3600,
          }),
        });
        expect(automationResponse.status).toBe(200);

        const visibleAutomations = await fetch(`${baseUrl}/api/automations`, {
          headers: { authorization: `Bearer ${operatorBody.token}` },
        });
        expect(visibleAutomations.status).toBe(200);
        const visibleAutomationsBody = (await visibleAutomations.json()) as {
          automations: Array<{ targetSystemId: string }>;
        };
        expect(visibleAutomationsBody.automations).toEqual(
          expect.arrayContaining([expect.objectContaining({ targetSystemId: "finance" })]),
        );

        const forbiddenAudit = await fetch(`${baseUrl}/api/audit-log`, {
          headers: { authorization: `Bearer ${operatorBody.token}` },
        });
        expect(forbiddenAudit.status).toBe(403);

        const grantAudit = await fetch(`${baseUrl}/api/system-permissions`, {
          method: "POST",
          headers: { authorization: "Bearer secret", "content-type": "application/json" },
          body: JSON.stringify({
            userId: operatorBody.operator.userId,
            systemId: "finance",
            permissions: ["audit"],
          }),
        });
        expect(grantAudit.status).toBe(200);
        const allowedAudit = await fetch(`${baseUrl}/api/audit-log`, {
          headers: { authorization: `Bearer ${operatorBody.token}` },
        });
        expect(allowedAudit.status).toBe(200);
      },
    );
  });

  it("exchanges operator tokens for persisted dashboard sessions", async () => {
    const state = createHiveServerState();
    await withServer(
      { state, adminToken: "secret", now: () => new Date("2026-06-14T15:00:00.000Z") },
      async (baseUrl) => {
        const operatorResponse = await fetch(`${baseUrl}/api/operators`, {
          method: "POST",
          headers: { authorization: "Bearer secret", "content-type": "application/json" },
          body: JSON.stringify({ email: "sessioned@example.com", role: "operator" }),
        });
        expect(operatorResponse.status).toBe(200);
        const operatorBody = (await operatorResponse.json()) as {
          token: string;
          operator: { userId: string };
        };

        const loginResponse = await fetch(`${baseUrl}/api/auth/login`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ token: operatorBody.token }),
        });
        expect(loginResponse.status).toBe(200);
        const loginBody = (await loginResponse.json()) as {
          token: string;
          actor: { userId: string; role: string };
          session: { userId: string; expiresAt: string };
        };
        expect(loginBody.token).toMatch(/^hp_op_sess_/);
        expect(loginBody.actor.userId).toBe(operatorBody.operator.userId);
        expect(loginBody.session.userId).toBe(operatorBody.operator.userId);
        expect(state.operatorSessions.size).toBe(1);

        const meResponse = await fetch(`${baseUrl}/api/auth/me`, {
          headers: { authorization: `Bearer ${loginBody.token}` },
        });
        expect(meResponse.status).toBe(200);
        const meBody = (await meResponse.json()) as { actor: { userId: string; role: string } };
        expect(meBody.actor).toMatchObject({
          userId: operatorBody.operator.userId,
          role: "operator",
        });
      },
    );
  });

  it("rejects expired operator dashboard sessions", async () => {
    const state = createHiveServerState();
    await withServer(
      { state, adminToken: "secret", now: () => new Date("2026-06-14T15:00:00.000Z") },
      async (baseUrl) => {
        const loginResponse = await fetch(`${baseUrl}/api/auth/login`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ token: "secret" }),
        });
        expect(loginResponse.status).toBe(200);
        const loginBody = (await loginResponse.json()) as { token: string };
        for (const session of state.operatorSessions.values()) {
          session.expiresAt = new Date("2000-01-01T00:00:00.000Z");
        }

        const meResponse = await fetch(`${baseUrl}/api/auth/me`, {
          headers: { authorization: `Bearer ${loginBody.token}` },
        });
        expect(meResponse.status).toBe(401);
        const body = (await meResponse.json()) as { reason: string };
        expect(body.reason).toBe("operator session expired");
      },
    );
  });

  it("requires approve permission for system-scoped job approval decisions", async () => {
    const state = createHiveServerState();
    upsertBeeHeartbeat(state, {
      type: "bee.heartbeat",
      beeId: "bee_agent",
      timestamp: "2026-05-09T08:00:00.000Z",
      daemonVersion: "0.0.7",
      status: "online",
      activeJobs: 0,
      healthChecks: [],
    });

    await withServer(
      { state, adminToken: "secret", now: () => new Date("2026-05-09T08:00:05.000Z") },
      async (baseUrl) => {
        const operatorResponse = await fetch(`${baseUrl}/api/operators`, {
          method: "POST",
          headers: { authorization: "Bearer secret", "content-type": "application/json" },
          body: JSON.stringify({ email: "approver@example.com", role: "operator" }),
        });
        const operatorBody = (await operatorResponse.json()) as {
          token: string;
          operator: { userId: string };
        };

        const grantRun = await fetch(`${baseUrl}/api/system-permissions`, {
          method: "POST",
          headers: { authorization: "Bearer secret", "content-type": "application/json" },
          body: JSON.stringify({
            userId: operatorBody.operator.userId,
            systemId: "finance",
            permissions: ["run"],
          }),
        });
        expect(grantRun.status).toBe(200);

        const jobResponse = await fetch(`${baseUrl}/api/bees/bee_agent/jobs`, {
          method: "POST",
          headers: { authorization: "Bearer secret", "content-type": "application/json" },
          body: JSON.stringify({
            type: "run_command",
            payload: { command: "rm -rf /tmp/example" },
            context: { metadata: { targetSystemId: "finance" } },
          }),
        });
        expect(jobResponse.status).toBe(200);
        const jobBody = (await jobResponse.json()) as { job: { id: string; status: string } };
        expect(jobBody.job.status).toBe("waiting_for_approval");

        const forbiddenApproval = await fetch(`${baseUrl}/api/jobs/${jobBody.job.id}/approve`, {
          method: "POST",
          headers: { authorization: `Bearer ${operatorBody.token}` },
        });
        expect(forbiddenApproval.status).toBe(403);

        const grantApprove = await fetch(`${baseUrl}/api/system-permissions`, {
          method: "POST",
          headers: { authorization: "Bearer secret", "content-type": "application/json" },
          body: JSON.stringify({
            userId: operatorBody.operator.userId,
            systemId: "finance",
            permissions: ["approve"],
          }),
        });
        expect(grantApprove.status).toBe(200);

        const approved = await fetch(`${baseUrl}/api/jobs/${jobBody.job.id}/approve`, {
          method: "POST",
          headers: { authorization: `Bearer ${operatorBody.token}` },
        });
        expect(approved.status).toBe(200);
        const approvedBody = (await approved.json()) as {
          job: { status: string; payload: { hiveApproval?: { approvedBy?: string } } };
        };
        expect(approvedBody.job.status).toBe("queued");
        expect(approvedBody.job.payload.hiveApproval).toMatchObject({
          approvedBy: operatorBody.operator.userId,
        });
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
        localModels: [],
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
            requirements: { modelBackends: ["ollama"], models: ["gemma4:12b"] },
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
            localModels: [
              {
                backend: "ollama",
                name: "gemma4:12b",
                endpointUrl: "http://127.0.0.1:11434",
                resourceHints: {},
              },
            ],
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

  it("prefers Bees that already hold the requested work context", async () => {
    const state = createHiveServerState();
    const baseCapabilities = {
      runtimes: ["openclaw"],
      modelBackends: [],
      models: [],
      localModels: [],
      tools: ["filesystem"],
      networking: [],
      hardware: {
        platform: "darwin-arm64" as const,
        hostname: "bee",
        cpuCores: 10,
        memoryGb: 32,
      },
    };
    upsertBeeHeartbeat(state, {
      type: "bee.heartbeat",
      beeId: "bee_empty",
      timestamp: "2026-05-09T08:00:00.000Z",
      daemonVersion: "0.0.7",
      status: "online",
      activeJobs: 0,
      capabilities: { ...baseCapabilities, hardware: { ...baseCapabilities.hardware } },
      healthChecks: [],
    });
    upsertBeeHeartbeat(state, {
      type: "bee.heartbeat",
      beeId: "bee_context",
      timestamp: "2026-05-09T08:00:00.000Z",
      daemonVersion: "0.0.7",
      status: "online",
      activeJobs: 4,
      capabilities: {
        ...baseCapabilities,
        agentSessions: [
          {
            id: "hiveplane-task-task_existing",
            runtime: "openclaw",
            status: "recent",
            taskId: "task_existing",
            workingDirectory: "/Users/austin/repo",
            updatedAt: "2026-05-09T07:59:00.000Z",
            metadata: {},
          },
        ],
        hardware: { ...baseCapabilities.hardware, hostname: "bee-context" },
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
            title: "Continue repo work",
            instructions: "Pick up the existing work.",
            requirements: { runtimes: ["openclaw"] },
            context: {
              sessionId: "hiveplane-task-task_existing",
              runtime: "openclaw",
              workingDirectory: "/Users/austin/repo",
            },
          }),
        });

        expect(response.status).toBe(200);
        const body = (await response.json()) as {
          task: { assignedBeeId: string; context: { sessionId?: string }; jobId: string };
        };
        expect(body.task).toMatchObject({
          assignedBeeId: "bee_context",
          context: { sessionId: "hiveplane-task-task_existing" },
        });
        const job = state.jobsState.jobs.get(body.task.jobId);
        expect(job?.context).toMatchObject({
          sessionId: "hiveplane-task-task_existing",
          workingDirectory: "/Users/austin/repo",
        });
      },
    );
  });

  it("runs due interval automations as Hive tasks", async () => {
    const state = createHiveServerState();
    let current = new Date("2026-05-09T08:00:00.000Z");
    upsertBeeHeartbeat(state, {
      type: "bee.heartbeat",
      beeId: "bee_automation",
      timestamp: "2026-05-09T08:00:00.000Z",
      daemonVersion: "0.0.7",
      status: "online",
      activeJobs: 0,
      capabilities: {
        runtimes: ["openclaw"],
        modelBackends: [],
        models: [],
        localModels: [],
        tools: ["filesystem"],
        networking: [],
        hardware: {
          platform: "darwin-arm64",
          hostname: "bee-automation",
          cpuCores: 10,
          memoryGb: 32,
        },
      },
      healthChecks: [],
    });

    await withServer({ state, adminToken: "secret", now: () => current }, async (baseUrl) => {
      const create = await fetch(`${baseUrl}/api/automations`, {
        method: "POST",
        headers: { authorization: "Bearer secret", "content-type": "application/json" },
        body: JSON.stringify({
          title: "Watch repo",
          instructions: "Check the repo and report issues.",
          trigger: "interval",
          everySeconds: 60,
          requirements: { runtimes: ["openclaw"] },
        }),
      });
      expect(create.status).toBe(200);
      const created = (await create.json()) as {
        automation: { id: string; nextRunAt: string; lastTaskId?: string };
      };
      expect(created.automation.lastTaskId).toBeUndefined();

      current = new Date("2026-05-09T08:01:01.000Z");
      const list = await fetch(`${baseUrl}/api/automations`, {
        headers: { authorization: "Bearer secret" },
      });
      expect(list.status).toBe(200);
      const body = (await list.json()) as {
        automations: Array<{
          id: string;
          status: string;
          lastTaskId?: string;
          lastJobId?: string;
          lastRunAt?: string;
          nextRunAt?: string;
        }>;
      };
      const automation = body.automations.find((item) => item.id === created.automation.id);
      expect(automation).toMatchObject({
        status: "enabled",
        lastTaskId: expect.stringMatching(/^task_/),
        lastJobId: expect.stringMatching(/^job_/),
        lastRunAt: "2026-05-09T08:01:01.000Z",
      });
      expect(automation?.nextRunAt).toBe("2026-05-09T08:02:01.000Z");
      expect(state.tasks.get(automation?.lastTaskId ?? "")).toMatchObject({
        status: "assigned",
        assignedBeeId: "bee_automation",
      });
    });
  });

  it("routes Hive tasks by connector requirements", async () => {
    const state = createHiveServerState();
    upsertBeeHeartbeat(state, {
      type: "bee.heartbeat",
      beeId: "bee_files",
      timestamp: "2026-05-09T08:00:00.000Z",
      daemonVersion: "0.0.7",
      status: "online",
      activeJobs: 0,
      capabilities: {
        runtimes: ["openclaw"],
        modelBackends: [],
        models: [],
        localModels: [],
        connectors: [
          {
            id: "filesystem",
            label: "Filesystem",
            kind: "filesystem",
            status: "available",
            details: {},
          },
        ],
        tools: ["filesystem"],
        networking: [],
        hardware: {
          platform: "darwin-arm64",
          hostname: "bee-files",
          cpuCores: 10,
          memoryGb: 32,
        },
      },
      healthChecks: [],
    });
    upsertBeeHeartbeat(state, {
      type: "bee.heartbeat",
      beeId: "bee_github",
      timestamp: "2026-05-09T08:00:00.000Z",
      daemonVersion: "0.0.7",
      status: "online",
      activeJobs: 2,
      capabilities: {
        runtimes: ["openclaw"],
        modelBackends: [],
        models: [],
        localModels: [],
        connectors: [
          {
            id: "filesystem",
            label: "Filesystem",
            kind: "filesystem",
            status: "available",
            details: {},
          },
          { id: "github", label: "GitHub", kind: "cloud", status: "available", details: {} },
        ],
        tools: ["filesystem"],
        networking: [],
        hardware: {
          platform: "darwin-arm64",
          hostname: "bee-github",
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
            title: "Open PR",
            instructions: "Use GitHub.",
            requirements: { runtimes: ["openclaw"], connectors: ["github"] },
          }),
        });

        expect(response.status).toBe(200);
        const body = (await response.json()) as {
          task: { assignedBeeId: string; requirements: { connectors: string[] } };
        };
        expect(body.task).toMatchObject({
          assignedBeeId: "bee_github",
          requirements: { connectors: ["github"] },
        });
      },
    );
  });

  it("cancels Hive tasks and ignores late Bee completion status", async () => {
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
        modelBackends: [],
        models: [],
        localModels: [],
        tools: ["filesystem"],
        networking: [],
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
        const createResponse = await fetch(`${baseUrl}/api/tasks`, {
          method: "POST",
          headers: { authorization: "Bearer secret", "content-type": "application/json" },
          body: JSON.stringify({
            title: "Long task",
            instructions: "Run until cancelled.",
            requirements: { runtimes: ["openclaw"] },
          }),
        });
        expect(createResponse.status).toBe(200);
        const createBody = (await createResponse.json()) as {
          task: { id: string; status: string; jobId: string };
        };

        const firstHeartbeat = await fetch(`${baseUrl}/api/bees/heartbeat`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            type: "bee.heartbeat",
            beeId: "bee_agent",
            timestamp: "2026-05-09T08:00:06.000Z",
            daemonVersion: "0.0.7",
            status: "online",
            activeJobs: 0,
            healthChecks: [],
          }),
        });
        expect(firstHeartbeat.status).toBe(200);
        const firstHeartbeatBody = (await firstHeartbeat.json()) as {
          jobs: Array<{ id: string }>;
        };
        expect(firstHeartbeatBody.jobs.map((job) => job.id)).toContain(createBody.task.jobId);

        const cancelResponse = await fetch(`${baseUrl}/api/tasks/${createBody.task.id}/cancel`, {
          method: "POST",
          headers: { authorization: "Bearer secret" },
        });
        expect(cancelResponse.status).toBe(200);
        const cancelBody = (await cancelResponse.json()) as {
          task: { status: string; lastError: string };
        };
        expect(cancelBody.task).toMatchObject({
          status: "cancelled",
          lastError: "Cancelled by Hive admin.",
        });

        const cancelHeartbeat = await fetch(`${baseUrl}/api/bees/heartbeat`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            type: "bee.heartbeat",
            beeId: "bee_agent",
            timestamp: "2026-05-09T08:00:06.500Z",
            daemonVersion: "0.0.7",
            status: "online",
            activeJobs: 1,
            healthChecks: [],
          }),
        });
        expect(cancelHeartbeat.status).toBe(200);
        const cancelHeartbeatBody = (await cancelHeartbeat.json()) as {
          cancellations: Array<{ jobId: string; type: string }>;
        };
        expect(cancelHeartbeatBody.cancellations).toEqual([
          expect.objectContaining({ type: "job.cancel", jobId: createBody.task.jobId }),
        ]);

        const completeResponse = await fetch(
          `${baseUrl}/api/jobs/${createBody.task.jobId}/complete`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              type: "job.complete",
              jobId: createBody.task.jobId,
              beeId: "bee_agent",
              status: "succeeded",
              completedAt: "2026-05-09T08:00:07.000Z",
              output: { message: "too late" },
            }),
          },
        );
        expect(completeResponse.status).toBe(200);

        const detailResponse = await fetch(`${baseUrl}/api/tasks/${createBody.task.id}`, {
          headers: { authorization: "Bearer secret" },
        });
        expect(detailResponse.status).toBe(200);
        const detail = (await detailResponse.json()) as {
          task: { status: string };
          job: {
            status: string;
            error: { code: string };
            events: Array<{ type: string; actor: string }>;
          };
        };
        expect(detail.task.status).toBe("cancelled");
        expect(detail.job).toMatchObject({
          status: "cancelled",
          error: { code: "job_cancelled" },
        });
        expect(detail.job.events).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ type: "job.cancel.requested", actor: "hive" }),
            expect.objectContaining({ type: "job.cancel.delivered", actor: "hive" }),
          ]),
        );
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
          permissionProfile: "server_worker",
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
            permissionProfile: string;
            offlineGraceSeconds: number;
            criticalServices: string[];
          };
        };
      };
      expect(body.bee.profile).toMatchObject({
        availabilityClass: "critical",
        permissionProfile: "server_worker",
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

  it("rejects invalid Bee permission profiles", async () => {
    const state = createHiveServerState();
    upsertBeeHeartbeat(state, {
      type: "bee.heartbeat",
      beeId: "bee_bad_permission_profile",
      timestamp: "2026-05-09T08:00:00.000Z",
      daemonVersion: "0.0.7",
      status: "online",
      activeJobs: 0,
      healthChecks: [],
    });

    await withServer({ state, adminToken: "secret" }, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/bees/bee_bad_permission_profile/profile`, {
        method: "PATCH",
        headers: { authorization: "Bearer secret", "content-type": "application/json" },
        body: JSON.stringify({
          permissionProfile: "root_everything",
        }),
      });

      expect(response.status).toBe(400);
      const body = (await response.json()) as { error: string; reason: string };
      expect(body).toMatchObject({
        error: "bad_request",
        reason: "permissionProfile is invalid",
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

  it("links recovery job artifacts back to incident attempts", async () => {
    const state = createHiveServerState();
    const job = createJob(
      state.jobsState,
      "bee_evidence",
      {
        type: "collect_bee_logs",
        payload: { incidentId: "bee_evidence:bee_offline" },
      },
      new Date("2026-05-09T08:00:00.000Z"),
    );
    state.incidents.set("bee_evidence:bee_offline", {
      id: "bee_evidence:bee_offline",
      beeId: "bee_evidence",
      kind: "bee_offline",
      status: "recovering",
      severity: "critical",
      summary: "Bee is offline.",
      detectedAt: "2026-05-09T07:59:00.000Z",
      updatedAt: "2026-05-09T08:00:00.000Z",
      attempts: [
        {
          jobId: job.id,
          action: "collect_bee_logs",
          queuedAt: "2026-05-09T08:00:00.000Z",
        },
      ],
      notifications: [],
    });

    await withServer({ state, adminToken: "secret" }, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/jobs/${job.id}/complete`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          type: "job.complete",
          jobId: job.id,
          beeId: "bee_evidence",
          status: "failed",
          completedAt: "2026-05-09T08:01:00.000Z",
          error: {
            code: "logs_failed",
            message: "log collection failed",
            artifacts: [{ id: "art_logs", name: "bee.log", localPath: "/tmp/bee.log" }],
          },
        }),
      });

      expect(response.status).toBe(200);
      expect(state.jobsState.jobs.get(job.id)?.artifacts).toEqual(
        expect.arrayContaining([expect.objectContaining({ id: "art_logs", name: "bee.log" })]),
      );
      expect(state.incidents.get("bee_evidence:bee_offline")?.attempts[0]).toMatchObject({
        status: "failed",
        artifactIds: ["art_logs"],
      });
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
    writeFileSync(
      join(installDir, "bee.sh"),
      '#!/bin/sh\nREPO_URL="${HIVEPLANE_REPO_URL:-https://github.com/AustinNChristensen/HivePlane.git}"\nREPO_REF="${HIVEPLANE_REPO_REF:-main}"\necho hi from bee installer\n',
    );
    writeFileSync(join(installDir, "hive.sh"), "#!/bin/sh\necho hi from hive installer\n");
    const oldRepoUrl = process.env.HIVEPLANE_REPO_URL;
    const oldRepoRef = process.env.HIVEPLANE_REPO_REF;
    process.env.HIVEPLANE_REPO_URL = "https://github.com/example/fork.git";
    process.env.HIVEPLANE_REPO_REF = "release-1";

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
      const beeBody = await beeRes.text();
      expect(beeBody).toContain("hi from bee installer");
      expect(beeBody).toContain(
        'REPO_URL="${HIVEPLANE_REPO_URL:-https://github.com/example/fork.git}"',
      );
      expect(beeBody).toContain('REPO_REF="${HIVEPLANE_REPO_REF:-release-1}"');

      const hiveRes = await fetch(`${baseUrl}/install/hive.sh`);
      expect(hiveRes.status).toBe(200);
      expect(await hiveRes.text()).toContain("hi from hive installer");

      const wrongRes = await fetch(`${baseUrl}/install/evil.sh`);
      expect(wrongRes.status).toBe(404);
    } finally {
      server.close();
      if (oldRepoUrl === undefined) delete process.env.HIVEPLANE_REPO_URL;
      else process.env.HIVEPLANE_REPO_URL = oldRepoUrl;
      if (oldRepoRef === undefined) delete process.env.HIVEPLANE_REPO_REF;
      else process.env.HIVEPLANE_REPO_REF = oldRepoRef;
    }
  });

  it("serves the landing page at / and dashboard at /dashboard and /index.html", async () => {
    const publicDir = mkdtempSync(join(tmpdir(), "hiveplane-public-test-"));
    writeFileSync(join(publicDir, "landing.html"), "<!doctype html><title>Test Landing</title>");
    writeFileSync(join(publicDir, "index.html"), "<!doctype html><title>Test Dashboard</title>");

    const server = createHiveServer({ publicDir });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");

    try {
      const address = server.address();
      if (!address || typeof address !== "object")
        throw new Error("server did not bind to a TCP port");
      const baseUrl = `http://127.0.0.1:${address.port}`;

      const landing = await fetch(`${baseUrl}/`);
      expect(landing.status).toBe(200);
      expect(landing.headers.get("content-type")).toContain("text/html");
      expect(await landing.text()).toContain("Test Landing");

      for (const path of ["/dashboard", "/dashboard/", "/index.html"]) {
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
      expect(body.error).toBe("landing_not_built");
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
