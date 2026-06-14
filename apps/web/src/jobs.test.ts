import { generateKeyPairSync, sign as edSign } from "node:crypto";
import { once } from "node:events";
import { describe, expect, it } from "vitest";
import { createHiveServer, createHiveServerState } from "./server.js";

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

function generateBeeKeypair() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  };
}

async function setupBee(state: ReturnType<typeof createHiveServerState>, baseUrl: string) {
  const keypair = generateBeeKeypair();
  const tokenRes = await fetch(`${baseUrl}/api/bootstrap-tokens`, {
    method: "POST",
    headers: { authorization: "Bearer admin-secret", "content-type": "application/json" },
    body: JSON.stringify({}),
  });
  const { token } = (await tokenRes.json()) as { token: string };

  const reg = await fetch(`${baseUrl}/api/bees/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      type: "bee.registration.request",
      bootstrapToken: token,
      publicKey: keypair.publicKeyPem,
      beeName: "job-test-bee",
      daemonVersion: "0.0.1-test",
      hiveUrl: baseUrl,
      labels: {},
      capabilities: {
        runtimes: [],
        modelBackends: [],
        models: [],
        tools: [],
        networking: [],
        hardware: {
          platform: "darwin-arm64",
          hostname: "test",
          cpuCores: 1,
          memoryGb: 1,
        },
      },
      requestedAt: new Date().toISOString(),
    }),
  });
  const body = (await reg.json()) as { beeId: string; sessionToken: string };
  return { beeId: body.beeId, sessionToken: body.sessionToken, ...keypair };
}

describe("POST /api/bees/:beeId/jobs", () => {
  it("requires admin auth", async () => {
    const state = createHiveServerState();
    await withServer({ state, adminToken: "admin-secret", authRequired: true }, async (baseUrl) => {
      const { beeId } = await setupBee(state, baseUrl);
      const res = await fetch(`${baseUrl}/api/bees/${beeId}/jobs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "run_healthcheck", payload: {} }),
      });
      expect(res.status).toBe(401);
    });
  });

  it("404s for an unknown bee", async () => {
    await withServer({ adminToken: "admin-secret" }, async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/bees/bee_unknown/jobs`, {
        method: "POST",
        headers: {
          authorization: "Bearer admin-secret",
          "content-type": "application/json",
        },
        body: JSON.stringify({ type: "run_healthcheck", payload: {} }),
      });
      expect(res.status).toBe(404);
    });
  });

  it("creates a queued job an admin can list and inspect", async () => {
    const state = createHiveServerState();
    await withServer({ state, adminToken: "admin-secret", authRequired: true }, async (baseUrl) => {
      const { beeId } = await setupBee(state, baseUrl);
      const create = await fetch(`${baseUrl}/api/bees/${beeId}/jobs`, {
        method: "POST",
        headers: {
          authorization: "Bearer admin-secret",
          "content-type": "application/json",
        },
        body: JSON.stringify({ type: "run_command", payload: { command: "hostname" } }),
      });
      expect(create.status).toBe(200);
      const created = (await create.json()) as { job: { id: string; status: string } };
      expect(created.job.status).toBe("queued");

      const get = await fetch(`${baseUrl}/api/jobs/${created.job.id}`, {
        headers: { authorization: "Bearer admin-secret" },
      });
      expect(get.status).toBe(200);

      const list = await fetch(`${baseUrl}/api/jobs?beeId=${beeId}`, {
        headers: { authorization: "Bearer admin-secret" },
      });
      const listed = (await list.json()) as { jobs: Array<{ id: string }> };
      expect(listed.jobs.map((j) => j.id)).toContain(created.job.id);
    });
  });

  it("lets an admin cancel a queued job", async () => {
    const state = createHiveServerState();
    await withServer({ state, adminToken: "admin-secret", authRequired: true }, async (baseUrl) => {
      const { beeId } = await setupBee(state, baseUrl);
      const create = await fetch(`${baseUrl}/api/bees/${beeId}/jobs`, {
        method: "POST",
        headers: {
          authorization: "Bearer admin-secret",
          "content-type": "application/json",
        },
        body: JSON.stringify({ type: "run_healthcheck", payload: {} }),
      });
      const created = (await create.json()) as { job: { id: string } };

      const cancel = await fetch(`${baseUrl}/api/jobs/${created.job.id}/cancel`, {
        method: "POST",
        headers: { authorization: "Bearer admin-secret" },
      });
      expect(cancel.status).toBe(200);
      const cancelled = (await cancel.json()) as {
        job: { status: string; error: { code: string }; events: Array<{ type: string }> };
      };
      expect(cancelled.job).toMatchObject({
        status: "cancelled",
        error: { code: "job_cancelled" },
      });
      expect(cancelled.job.events).toEqual(
        expect.arrayContaining([expect.objectContaining({ type: "job.cancel.requested" })]),
      );
    });
  });

  it("holds mutating jobs for admin approval before dispatch", async () => {
    const state = createHiveServerState();
    await withServer({ state, adminToken: "admin-secret", authRequired: true }, async (baseUrl) => {
      const { beeId } = await setupBee(state, baseUrl);
      const create = await fetch(`${baseUrl}/api/bees/${beeId}/jobs`, {
        method: "POST",
        headers: {
          authorization: "Bearer admin-secret",
          "content-type": "application/json",
        },
        body: JSON.stringify({ type: "install_runtime", payload: { runtime: "ollama" } }),
      });
      expect(create.status).toBe(200);
      const created = (await create.json()) as { job: { id: string; status: string } };
      expect(created.job.status).toBe("waiting_for_approval");

      const approve = await fetch(`${baseUrl}/api/jobs/${created.job.id}/approve`, {
        method: "POST",
        headers: { authorization: "Bearer admin-secret" },
      });
      expect(approve.status).toBe(200);
      const approved = (await approve.json()) as { job: { status: string } };
      expect(approved.job.status).toBe("queued");
    });
  });
});

describe("end-to-end: heartbeat picks up jobs, bee streams events + completes", () => {
  it("queued job → assigned via heartbeat → bee posts events + complete (signed)", async () => {
    const state = createHiveServerState();
    await withServer({ state, adminToken: "admin-secret", authRequired: true }, async (baseUrl) => {
      const { beeId, sessionToken, privateKeyPem } = await setupBee(state, baseUrl);

      // 1. Admin enqueues a job for this bee.
      const createRes = await fetch(`${baseUrl}/api/bees/${beeId}/jobs`, {
        method: "POST",
        headers: {
          authorization: "Bearer admin-secret",
          "content-type": "application/json",
        },
        body: JSON.stringify({ type: "run_healthcheck", payload: {} }),
      });
      const { job } = (await createRes.json()) as { job: { id: string } };

      // 2. Bee heartbeats (signed) → response includes the job, status now "assigned".
      const heartbeatBody = JSON.stringify({
        type: "bee.heartbeat",
        beeId,
        timestamp: new Date().toISOString(),
        daemonVersion: "0.0.1-test",
        status: "online",
        activeJobs: 0,
      });
      const heartbeatSig = edSign(null, Buffer.from(heartbeatBody), privateKeyPem).toString(
        "base64url",
      );
      const heartbeatRes = await fetch(`${baseUrl}/api/bees/heartbeat`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${sessionToken}`,
          "content-type": "application/json",
          "x-bee-signature": heartbeatSig,
        },
        body: heartbeatBody,
      });
      expect(heartbeatRes.status).toBe(200);
      const heartbeatJson = (await heartbeatRes.json()) as {
        jobs: Array<{ id: string; status: string }>;
      };
      expect(heartbeatJson.jobs).toHaveLength(1);
      expect(heartbeatJson.jobs[0]?.id).toBe(job.id);
      expect(heartbeatJson.jobs[0]?.status).toBe("assigned");

      // 3. Bee posts an event (signed).
      const eventsBody = JSON.stringify({
        type: "job.events.append",
        jobId: job.id,
        beeId,
        events: [
          {
            id: "evt_1",
            jobId: job.id,
            beeId,
            sequence: 1,
            type: "command.start",
            level: "info",
            actor: "bee",
            actorId: beeId,
            data: {},
            createdAt: new Date().toISOString(),
          },
        ],
      });
      const eventsSig = edSign(null, Buffer.from(eventsBody), privateKeyPem).toString("base64url");
      const eventsRes = await fetch(`${baseUrl}/api/jobs/${job.id}/events`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${sessionToken}`,
          "content-type": "application/json",
          "x-bee-signature": eventsSig,
        },
        body: eventsBody,
      });
      expect(eventsRes.status).toBe(200);

      // 4. Bee completes the job (signed).
      const completeBody = JSON.stringify({
        type: "job.complete",
        jobId: job.id,
        beeId,
        status: "succeeded",
        output: { ok: true },
        completedAt: new Date().toISOString(),
      });
      const completeSig = edSign(null, Buffer.from(completeBody), privateKeyPem).toString(
        "base64url",
      );
      const completeRes = await fetch(`${baseUrl}/api/jobs/${job.id}/complete`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${sessionToken}`,
          "content-type": "application/json",
          "x-bee-signature": completeSig,
        },
        body: completeBody,
      });
      expect(completeRes.status).toBe(200);

      // 5. Admin inspects: status=succeeded, has the event.
      const inspect = await fetch(`${baseUrl}/api/jobs/${job.id}`, {
        headers: { authorization: "Bearer admin-secret" },
      });
      const inspected = (await inspect.json()) as {
        job: { status: string; events: unknown[]; output?: { ok?: boolean } };
      };
      expect(inspected.job.status).toBe("succeeded");
      expect(inspected.job.events.length).toBe(1);
      expect(inspected.job.output?.ok).toBe(true);
    });
  });

  it("event/complete from a session that doesn't own the job → 403", async () => {
    const state = createHiveServerState();
    await withServer({ state, adminToken: "admin-secret", authRequired: true }, async (baseUrl) => {
      const beeA = await setupBee(state, baseUrl);
      const beeB = await setupBee(state, baseUrl);

      // Job created for beeA.
      const createRes = await fetch(`${baseUrl}/api/bees/${beeA.beeId}/jobs`, {
        method: "POST",
        headers: {
          authorization: "Bearer admin-secret",
          "content-type": "application/json",
        },
        body: JSON.stringify({ type: "run_healthcheck", payload: {} }),
      });
      const { job } = (await createRes.json()) as { job: { id: string } };

      // beeB tries to complete it (signed correctly *for beeB*).
      const completeBody = JSON.stringify({
        type: "job.complete",
        jobId: job.id,
        beeId: beeB.beeId,
        status: "succeeded",
        completedAt: new Date().toISOString(),
      });
      const sig = edSign(null, Buffer.from(completeBody), beeB.privateKeyPem).toString("base64url");
      const res = await fetch(`${baseUrl}/api/jobs/${job.id}/complete`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${beeB.sessionToken}`,
          "content-type": "application/json",
          "x-bee-signature": sig,
        },
        body: completeBody,
      });
      expect(res.status).toBe(403);
    });
  });
});
