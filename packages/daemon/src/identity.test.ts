import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  getBeeIdentityPaths,
  loadOrCreateBeeIdentity,
  signBeeChallenge,
  verifyBeeChallengeSignature,
} from "./identity.js";

describe("Bee identity", () => {
  it("creates and reuses a persistent identity", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hiveplane-identity-"));

    try {
      const first = await loadOrCreateBeeIdentity({
        configDir: dir,
        beeId: "bee_test",
        now: new Date("2026-05-08T20:00:00.000Z"),
      });
      const second = await loadOrCreateBeeIdentity({ configDir: dir });

      expect(second).toEqual(first);
      expect(first.beeId).toBe("bee_test");
      expect(first.fingerprint).toMatch(/^sha256:/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("stores identity and private key with owner-only permissions", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hiveplane-identity-perms-"));

    try {
      await loadOrCreateBeeIdentity({ configDir: dir });
      const paths = getBeeIdentityPaths(dir);
      const identityMode = (await stat(paths.identityPath)).mode & 0o777;
      const privateKeyMode = (await stat(paths.privateKeyPath)).mode & 0o777;

      expect(identityMode & 0o077).toBe(0);
      expect(privateKeyMode & 0o077).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("signs and verifies registration challenges", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hiveplane-identity-sign-"));

    try {
      const identity = await loadOrCreateBeeIdentity({ configDir: dir });
      const challenge = "register:bee_test:2026-05-08T20:00:00.000Z";
      const signature = signBeeChallenge(identity, challenge);

      expect(verifyBeeChallengeSignature(identity.publicKeyPem, challenge, signature)).toBe(true);
      expect(
        verifyBeeChallengeSignature(identity.publicKeyPem, `${challenge}:tampered`, signature),
      ).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
