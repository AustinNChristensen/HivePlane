import { generateKeyPairSync, createHash, sign, verify } from "node:crypto";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { chmod } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";

export const BeeIdentitySchema = z.object({
  beeId: z.string().min(1).optional(),
  publicKeyPem: z.string().min(1),
  privateKeyPath: z.string().min(1),
  fingerprint: z.string().min(1),
  createdAt: z.string().datetime(),
});

export type BeeIdentity = z.infer<typeof BeeIdentitySchema>;

export type BeeIdentityPaths = {
  configDir: string;
  identityPath: string;
  privateKeyPath: string;
};

export type LoadOrCreateBeeIdentityOptions = {
  configDir?: string;
  beeId?: string;
  now?: Date;
};

export function getDefaultHivePlaneConfigDir(): string {
  return join(homedir(), ".hiveplane");
}

export function getBeeIdentityPaths(configDir = getDefaultHivePlaneConfigDir()): BeeIdentityPaths {
  return {
    configDir,
    identityPath: join(configDir, "bee-identity.json"),
    privateKeyPath: join(configDir, "bee-ed25519.key"),
  };
}

export function createPublicKeyFingerprint(publicKeyPem: string): string {
  const digest = createHash("sha256").update(publicKeyPem).digest("base64url");
  return `sha256:${digest}`;
}

export async function loadOrCreateBeeIdentity(
  options: LoadOrCreateBeeIdentityOptions = {},
): Promise<BeeIdentity> {
  const paths = getBeeIdentityPaths(options.configDir);
  mkdirSync(paths.configDir, { recursive: true, mode: 0o700 });

  try {
    const existing = BeeIdentitySchema.parse(JSON.parse(readFileSync(paths.identityPath, "utf8")));
    assertPrivateKeyPermissions(paths.privateKeyPath);
    return existing;
  } catch (error) {
    if (!isMissingIdentityError(error)) {
      throw error;
    }
  }

  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
  const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();

  writeFileSync(paths.privateKeyPath, privateKeyPem, { mode: 0o600 });
  await chmod(paths.privateKeyPath, 0o600);

  const identity: BeeIdentity = {
    beeId: options.beeId,
    publicKeyPem,
    privateKeyPath: paths.privateKeyPath,
    fingerprint: createPublicKeyFingerprint(publicKeyPem),
    createdAt: (options.now ?? new Date()).toISOString(),
  };

  writeFileSync(paths.identityPath, `${JSON.stringify(identity, null, 2)}\n`, { mode: 0o600 });
  await chmod(paths.identityPath, 0o600);

  return identity;
}

export function signBeeChallenge(identity: BeeIdentity, challenge: string): string {
  const privateKeyPem = readFileSync(identity.privateKeyPath, "utf8");
  return sign(null, Buffer.from(challenge), privateKeyPem).toString("base64url");
}

export function verifyBeeChallengeSignature(
  publicKeyPem: string,
  challenge: string,
  signatureBase64Url: string,
): boolean {
  return verify(
    null,
    Buffer.from(challenge),
    publicKeyPem,
    Buffer.from(signatureBase64Url, "base64url"),
  );
}

function assertPrivateKeyPermissions(privateKeyPath: string): void {
  const mode = statSync(privateKeyPath).mode & 0o777;
  if ((mode & 0o077) !== 0) {
    throw new Error(`Bee private key permissions are too broad: ${privateKeyPath}`);
  }
}

function isMissingIdentityError(error: unknown): boolean {
  return (
    error instanceof Error &&
    ("code" in error ? (error as NodeJS.ErrnoException).code === "ENOENT" : false)
  );
}
