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

function generateBeeKeypair(): { publicKeyPem: string; privateKeyPem: string } {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  };
}

describe("admin auth on POST /api/bootstrap-tokens", () => {
  it("503 when HIVEPLANE_ADMIN_TOKEN is not set on the server", async () => {
    await withServer({}, async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/bootstrap-tokens`, {
        method: "POST",
        headers: { authorization: "Bearer anything" },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(503);
    });
  });

  it("401 when no Authorization header", async () => {
    await withServer({ adminToken: "secret" }, async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/bootstrap-tokens`, { method: "POST", body: "{}" });
      expect(res.status).toBe(401);
    });
  });

  it("401 when Bearer token doesn't match", async () => {
    await withServer({ adminToken: "secret" }, async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/bootstrap-tokens`, {
        method: "POST",
        headers: { authorization: "Bearer wrong" },
        body: "{}",
      });
      expect(res.status).toBe(401);
    });
  });

  it("200 + token when admin auth matches", async () => {
    await withServer({ adminToken: "secret" }, async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/bootstrap-tokens`, {
        method: "POST",
        headers: {
          authorization: "Bearer secret",
          "content-type": "application/json",
        },
        body: JSON.stringify({ beeName: "mac-mini" }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { token: string; tokenId: string; expiresAt: string };
      expect(body.token).toMatch(/^hp_boot_/);
      expect(body.tokenId).toMatch(/^bt_/);
      expect(new Date(body.expiresAt).getTime()).toBeGreaterThan(Date.now());
    });
  });
});

describe("POST /api/bees/register", () => {
  it("rejects an unknown bootstrap token", async () => {
    await withServer({}, async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/bees/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          type: "bee.registration.request",
          bootstrapToken: "hp_boot_does_not_exist",
          publicKey: generateBeeKeypair().publicKeyPem,
          beeName: "x",
          daemonVersion: "0.0.1-test",
          hiveUrl: "http://hive.example",
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
      expect(res.status).toBe(401);
    });
  });

  it("registers with a valid token, returns session, and refuses to consume token twice", async () => {
    const state = createHiveServerState();
    await withServer({ state, adminToken: "secret" }, async (baseUrl) => {
      // 1. mint a bootstrap token
      const tokenRes = await fetch(`${baseUrl}/api/bootstrap-tokens`, {
        method: "POST",
        headers: { authorization: "Bearer secret", "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      const tokenBody = (await tokenRes.json()) as { token: string };

      // 2. register with it
      const { publicKeyPem } = generateBeeKeypair();
      const reqBody = {
        type: "bee.registration.request",
        bootstrapToken: tokenBody.token,
        publicKey: publicKeyPem,
        beeName: "test-bee",
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
      };
      const regRes = await fetch(`${baseUrl}/api/bees/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(reqBody),
      });
      expect(regRes.status).toBe(200);
      const regBody = (await regRes.json()) as {
        beeId: string;
        sessionToken: string;
        sessionExpiresAt: string;
      };
      expect(regBody.beeId).toMatch(/^bee_/);
      expect(regBody.sessionToken).toMatch(/^hp_sess_/);
      expect(new Date(regBody.sessionExpiresAt).getTime()).toBeGreaterThan(Date.now());

      // 3. token is single-use
      const reuse = await fetch(`${baseUrl}/api/bees/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(reqBody),
      });
      expect(reuse.status).toBe(401);
    });
  });
});

describe("signed heartbeat enforcement", () => {
  async function setupRegisteredBee() {
    const { publicKeyPem, privateKeyPem } = generateBeeKeypair();
    const state = createHiveServerState();

    // Mint + register inline
    let beeId = "";
    let sessionToken = "";
    await withServer({ state, adminToken: "secret", authRequired: true }, async (baseUrl) => {
      const tokenRes = await fetch(`${baseUrl}/api/bootstrap-tokens`, {
        method: "POST",
        headers: { authorization: "Bearer secret", "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      const { token } = (await tokenRes.json()) as { token: string };

      const reg = await fetch(`${baseUrl}/api/bees/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          type: "bee.registration.request",
          bootstrapToken: token,
          publicKey: publicKeyPem,
          beeName: "auth-test",
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
      beeId = body.beeId;
      sessionToken = body.sessionToken;
    });
    return { state, publicKeyPem, privateKeyPem, beeId, sessionToken };
  }

  it("when authRequired=true: no headers → 401", async () => {
    const { state } = await setupRegisteredBee();
    await withServer({ state, authRequired: true }, async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/bees/heartbeat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          type: "bee.heartbeat",
          beeId: "anything",
          timestamp: new Date().toISOString(),
          daemonVersion: "0.0.1-test",
          status: "online",
          activeJobs: 0,
        }),
      });
      expect(res.status).toBe(401);
    });
  });

  it("valid session + valid signature → 200", async () => {
    const { state, beeId, sessionToken, privateKeyPem } = await setupRegisteredBee();
    await withServer({ state, authRequired: true }, async (baseUrl) => {
      const heartbeat = {
        type: "bee.heartbeat",
        beeId,
        timestamp: new Date().toISOString(),
        daemonVersion: "0.0.1-test",
        status: "online" as const,
        activeJobs: 0,
      };
      const rawBody = JSON.stringify(heartbeat);
      const signature = edSign(null, Buffer.from(rawBody), privateKeyPem).toString("base64url");

      const res = await fetch(`${baseUrl}/api/bees/heartbeat`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${sessionToken}`,
          "x-bee-signature": signature,
        },
        body: rawBody,
      });
      expect(res.status).toBe(200);
    });
  });

  it("valid session + WRONG signature → 401", async () => {
    const { state, beeId, sessionToken } = await setupRegisteredBee();
    await withServer({ state, authRequired: true }, async (baseUrl) => {
      const heartbeat = {
        type: "bee.heartbeat",
        beeId,
        timestamp: new Date().toISOString(),
        daemonVersion: "0.0.1-test",
        status: "online" as const,
        activeJobs: 0,
      };

      // Sign with a different key — should fail.
      const otherKey = generateBeeKeypair();
      const rawBody = JSON.stringify(heartbeat);
      const wrongSig = edSign(null, Buffer.from(rawBody), otherKey.privateKeyPem).toString(
        "base64url",
      );

      const res = await fetch(`${baseUrl}/api/bees/heartbeat`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${sessionToken}`,
          "x-bee-signature": wrongSig,
        },
        body: rawBody,
      });
      expect(res.status).toBe(401);
    });
  });

  it("session beeId mismatch → 401", async () => {
    const { state, sessionToken, privateKeyPem } = await setupRegisteredBee();
    await withServer({ state, authRequired: true }, async (baseUrl) => {
      const heartbeat = {
        type: "bee.heartbeat",
        beeId: "bee_someone_else",
        timestamp: new Date().toISOString(),
        daemonVersion: "0.0.1-test",
        status: "online" as const,
        activeJobs: 0,
      };
      const rawBody = JSON.stringify(heartbeat);
      const signature = edSign(null, Buffer.from(rawBody), privateKeyPem).toString("base64url");

      const res = await fetch(`${baseUrl}/api/bees/heartbeat`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${sessionToken}`,
          "x-bee-signature": signature,
        },
        body: rawBody,
      });
      expect(res.status).toBe(401);
    });
  });

  it("dev mode (authRequired=false): no headers → 200; bad headers → 401", async () => {
    await withServer({ authRequired: false }, async (baseUrl) => {
      const heartbeat = {
        type: "bee.heartbeat",
        beeId: "bee_unauth",
        timestamp: new Date().toISOString(),
        daemonVersion: "0.0.1-test",
        status: "online" as const,
        activeJobs: 0,
      };

      // no auth headers → accepted
      const res1 = await fetch(`${baseUrl}/api/bees/heartbeat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(heartbeat),
      });
      expect(res1.status).toBe(200);

      // partially-supplied auth → rejected (loud failure)
      const res2 = await fetch(`${baseUrl}/api/bees/heartbeat`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer hp_sess_garbage",
          "x-bee-signature": "AAAA",
        },
        body: JSON.stringify(heartbeat),
      });
      expect(res2.status).toBe(401);
    });
  });
});
