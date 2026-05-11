import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { registerBeeWithHive } from "./register.js";
import type { BeeIdentity } from "./identity.js";

function fakeIdentity(): BeeIdentity {
  const { publicKey } = generateKeyPairSync("ed25519");
  return {
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
    privateKeyPath: "/tmp/test-bee-key",
    fingerprint: "sha256:test",
    createdAt: new Date().toISOString(),
  };
}

/**
 * Build a fetch impl that throws a TypeError with a specific .cause.code —
 * the exact shape Node's undici-backed fetch emits for real network
 * failures. We use this to drive `describeNetworkError` through each
 * branch without binding a real socket.
 */
function failingFetch(code: string): typeof fetch {
  return (async () => {
    const cause = Object.assign(new Error(`mock ${code}`), { code });
    throw Object.assign(new TypeError("fetch failed"), { cause });
  }) as unknown as typeof fetch;
}

describe("registerBeeWithHive — network error translation", () => {
  const base = {
    hiveUrl: "http://hive.example.com:4483",
    pairingKey: "hp_pair_K7RQ2P9X",
    identity: fakeIdentity(),
    daemonVersion: "0.0.7-test",
  };

  it("translates ENOTFOUND into a DNS-resolution hint", async () => {
    await expect(
      registerBeeWithHive({ ...base, fetchImpl: failingFetch("ENOTFOUND") }),
    ).rejects.toThrowError(/could not resolve hive\.example\.com/);
    await expect(
      registerBeeWithHive({ ...base, fetchImpl: failingFetch("ENOTFOUND") }),
    ).rejects.toThrowError(/ping hive\.example\.com/);
  });

  it("translates ECONNREFUSED into a 'is the Hive running' hint", async () => {
    await expect(
      registerBeeWithHive({ ...base, fetchImpl: failingFetch("ECONNREFUSED") }),
    ).rejects.toThrowError(/connection refused at hive\.example\.com:4483/);
    await expect(
      registerBeeWithHive({ ...base, fetchImpl: failingFetch("ECONNREFUSED") }),
    ).rejects.toThrowError(/is the Hive running/);
  });

  it("translates ETIMEDOUT into a routing/firewall hint", async () => {
    await expect(
      registerBeeWithHive({ ...base, fetchImpl: failingFetch("ETIMEDOUT") }),
    ).rejects.toThrowError(/timed out connecting to hive\.example\.com:4483/);
    await expect(
      registerBeeWithHive({ ...base, fetchImpl: failingFetch("ETIMEDOUT") }),
    ).rejects.toThrowError(/firewall/);
  });

  it("translates ECONNRESET into a TLS-mismatch hint", async () => {
    await expect(
      registerBeeWithHive({ ...base, fetchImpl: failingFetch("ECONNRESET") }),
    ).rejects.toThrowError(/connection reset by hive\.example\.com:4483/);
  });

  it("translates TLS cert errors into an http-vs-https hint", async () => {
    await expect(
      registerBeeWithHive({ ...base, fetchImpl: failingFetch("CERT_HAS_EXPIRED") }),
    ).rejects.toThrowError(/TLS certificate problem/);
    await expect(
      registerBeeWithHive({ ...base, fetchImpl: failingFetch("CERT_HAS_EXPIRED") }),
    ).rejects.toThrowError(/drop the https:\/\/ from the Hive URL/);
  });

  it("falls back to a generic message + curl hint for unknown errors", async () => {
    await expect(
      registerBeeWithHive({ ...base, fetchImpl: failingFetch("ENONSENSE") }),
    ).rejects.toThrowError(/could not reach Hive at hive\.example\.com:4483/);
    await expect(
      registerBeeWithHive({ ...base, fetchImpl: failingFetch("ENONSENSE") }),
    ).rejects.toThrowError(/curl http:\/\/hive\.example\.com:4483\/healthz/);
  });
});
