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

    await withServer({ state, now: () => new Date("2026-05-09T20:02:04.000Z") }, async (baseUrl) => {
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
