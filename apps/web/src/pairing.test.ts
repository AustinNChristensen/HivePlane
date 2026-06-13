import { generateKeyPairSync } from "node:crypto";
import { once } from "node:events";
import { describe, expect, it } from "vitest";
import { createHiveServer, createHiveServerState, ensureActivePairingKey } from "./server.js";

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

function generateBeeKeypair(): { publicKeyPem: string } {
  const { publicKey } = generateKeyPairSync("ed25519");
  return { publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString() };
}

function buildRegistrationBody(extra: Record<string, unknown>) {
  return {
    type: "bee.registration.request",
    publicKey: (extra.publicKey as string | undefined) ?? generateBeeKeypair().publicKeyPem,
    beeName: "test-bee",
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
        platform: "darwin-arm64" as const,
        hostname: "test",
        cpuCores: 1,
        memoryGb: 1,
      },
    },
    requestedAt: new Date().toISOString(),
    ...extra,
  };
}

describe("GET /api/pairing-key", () => {
  it("503 when admin token isn't configured", async () => {
    await withServer({}, async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/pairing-key`, {
        headers: { authorization: "Bearer anything" },
      });
      expect(res.status).toBe(503);
    });
  });

  it("401 without a matching admin token", async () => {
    await withServer({ adminToken: "secret" }, async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/pairing-key`);
      expect(res.status).toBe(401);
    });
  });

  it("returns a stable, lazy-minted key on repeated GETs", async () => {
    await withServer({ adminToken: "secret" }, async (baseUrl) => {
      const fetchKey = async () =>
        (await (
          await fetch(`${baseUrl}/api/pairing-key`, {
            headers: { authorization: "Bearer secret" },
          })
        ).json()) as { code: string; display: string; expiresAt: string; keyId: string };

      const first = await fetchKey();
      expect(first.code).toMatch(/^[2-9A-HJKMNP-TV-Z]{8}$/);
      expect(first.display).toMatch(/^[2-9A-HJKMNP-TV-Z]{4}-[2-9A-HJKMNP-TV-Z]{4}$/);
      expect(new Date(first.expiresAt).getTime()).toBeGreaterThan(Date.now());

      const second = await fetchKey();
      expect(second.keyId).toBe(first.keyId);
      expect(second.code).toBe(first.code);
    });
  });
});

describe("POST /api/pairing-key/rotate", () => {
  it("rotates the active key and invalidates the old one", async () => {
    const state = createHiveServerState();
    await withServer({ state, adminToken: "secret" }, async (baseUrl) => {
      const before = (await (
        await fetch(`${baseUrl}/api/pairing-key`, {
          headers: { authorization: "Bearer secret" },
        })
      ).json()) as { code: string; keyId: string };

      const after = (await (
        await fetch(`${baseUrl}/api/pairing-key/rotate`, {
          method: "POST",
          headers: { authorization: "Bearer secret" },
        })
      ).json()) as { code: string; keyId: string };

      expect(after.keyId).not.toBe(before.keyId);
      expect(after.code).not.toBe(before.code);
      expect(state.activePairingKey?.keyId).toBe(after.keyId);
      expect(state.retiredPairingKeys[0]?.keyId).toBe(before.keyId);
    });
  });
});

describe("POST /api/bees/register with pairing key", () => {
  it("registers and rotates the key on success", async () => {
    const state = createHiveServerState();
    const initial = ensureActivePairingKey(state, new Date());

    await withServer({ state, adminToken: "secret" }, async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/bees/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(buildRegistrationBody({ pairingKey: `hp_pair_${initial.code}` })),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { beeId: string; sessionToken: string };
      expect(body.beeId).toMatch(/^bee_/);
      expect(body.sessionToken).toMatch(/^hp_sess_/);

      // The key that just paired must no longer be active.
      expect(state.activePairingKey?.keyId).not.toBe(initial.keyId);

      // Reusing the consumed key should now fail with a "rotated" hint.
      const reuse = await fetch(`${baseUrl}/api/bees/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(buildRegistrationBody({ pairingKey: `hp_pair_${initial.code}` })),
      });
      expect(reuse.status).toBe(401);
      const reuseBody = (await reuse.json()) as { reason: string };
      expect(reuseBody.reason).toMatch(/rotated/);
    });
  });

  it("reuses the existing Bee when the same public key pairs again", async () => {
    const state = createHiveServerState();
    const keypair = generateBeeKeypair();
    const firstKey = ensureActivePairingKey(state, new Date());

    await withServer({ state, adminToken: "secret" }, async (baseUrl) => {
      const first = await fetch(`${baseUrl}/api/bees/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(
          buildRegistrationBody({
            pairingKey: `hp_pair_${firstKey.code}`,
            publicKey: keypair.publicKeyPem,
            beeName: "Austin MBP",
          }),
        ),
      });
      expect(first.status).toBe(200);
      const firstBody = (await first.json()) as { beeId: string };

      const secondKey = ensureActivePairingKey(state, new Date(), true);
      const second = await fetch(`${baseUrl}/api/bees/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(
          buildRegistrationBody({
            pairingKey: `hp_pair_${secondKey.code}`,
            publicKey: keypair.publicKeyPem,
            beeName: "Austin MBP",
          }),
        ),
      });
      expect(second.status).toBe(200);
      const secondBody = (await second.json()) as { beeId: string };

      expect(secondBody.beeId).toBe(firstBody.beeId);
      expect(
        [...state.bees.values()].filter((bee) => bee.publicKey === keypair.publicKeyPem),
      ).toHaveLength(1);
    });
  });

  it("rejects an unknown pairing key", async () => {
    await withServer({}, async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/bees/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(buildRegistrationBody({ pairingKey: "hp_pair_AAAAAAAA" })),
      });
      expect(res.status).toBe(401);
    });
  });

  it("rejects a registration that supplies both credentials", async () => {
    const state = createHiveServerState();
    const initial = ensureActivePairingKey(state, new Date());
    await withServer({ state, adminToken: "secret" }, async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/bees/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(
          buildRegistrationBody({
            bootstrapToken: "hp_boot_test",
            pairingKey: `hp_pair_${initial.code}`,
          }),
        ),
      });
      // Schema-level rejection → 400, with the cross-field error message.
      expect(res.status).toBe(400);
    });
  });

  it("rate-limits brute-force attempts from one remote", async () => {
    const state = createHiveServerState();
    ensureActivePairingKey(state, new Date());

    await withServer({ state }, async (baseUrl) => {
      // 10 wrong guesses → still 401 each time, no lockout yet.
      for (let i = 0; i < 10; i += 1) {
        const res = await fetch(`${baseUrl}/api/bees/register`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(buildRegistrationBody({ pairingKey: "hp_pair_AAAAAAAA" })),
        });
        expect(res.status).toBe(401);
      }
      // 11th attempt should now be rate-limited.
      const blocked = await fetch(`${baseUrl}/api/bees/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(buildRegistrationBody({ pairingKey: "hp_pair_AAAAAAAA" })),
      });
      expect(blocked.status).toBe(429);
      const body = (await blocked.json()) as { error: string; reason: string };
      expect(body.error).toBe("rate_limited");
      expect(body.reason).toMatch(/retry in/);
    });
  });
});
