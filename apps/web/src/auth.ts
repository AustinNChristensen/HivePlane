import { createHash, randomBytes, verify, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";

const BOOTSTRAP_TOKEN_PREFIX = "hp_boot_";
const SESSION_TOKEN_PREFIX = "hp_sess_";

export type BootstrapTokenRecord = {
  tokenId: string;
  tokenHash: string;
  expiresAt: Date;
  beeName?: string;
  labels: Record<string, string>;
  consumedAt?: Date;
  consumedByBeeId?: string;
};

export type SessionRecord = {
  sessionId: string;
  beeId: string;
  tokenHash: string;
  expiresAt: Date;
  createdAt: Date;
};

export function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

export function generateBootstrapToken(): {
  tokenId: string;
  rawToken: string;
  tokenHash: string;
} {
  const tokenId = `bt_${randomBytes(8).toString("hex")}`;
  const rawToken = `${BOOTSTRAP_TOKEN_PREFIX}${randomBytes(24).toString("base64url")}`;
  return { tokenId, rawToken, tokenHash: sha256Hex(rawToken) };
}

export function generateSessionToken(): {
  sessionId: string;
  rawToken: string;
  tokenHash: string;
} {
  const sessionId = `sess_${randomBytes(8).toString("hex")}`;
  const rawToken = `${SESSION_TOKEN_PREFIX}${randomBytes(24).toString("base64url")}`;
  return { sessionId, rawToken, tokenHash: sha256Hex(rawToken) };
}

export function looksLikeBootstrapToken(token: string): boolean {
  return token.startsWith(BOOTSTRAP_TOKEN_PREFIX);
}

export function looksLikeSessionToken(token: string): boolean {
  return token.startsWith(SESSION_TOKEN_PREFIX);
}

/**
 * Constant-time string comparison via timingSafeEqual. Returns false if
 * lengths differ, which leaks length but that's acceptable for tokens of
 * fixed shape.
 */
export function safeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

export function verifyBeeSignature(
  publicKeyPem: string,
  body: Buffer,
  signatureBase64Url: string,
): boolean {
  try {
    return verify(null, body, publicKeyPem, Buffer.from(signatureBase64Url, "base64url"));
  } catch {
    return false;
  }
}

export type BearerExtraction = { token: string } | { error: string };

export function extractBearer(request: IncomingMessage): BearerExtraction {
  const header = request.headers.authorization ?? request.headers.Authorization;
  if (!header || Array.isArray(header)) {
    return { error: "missing Authorization header" };
  }
  const match = /^Bearer\s+(\S+)$/i.exec(header.toString());
  if (!match || !match[1]) {
    return { error: "Authorization header is not a Bearer token" };
  }
  return { token: match[1] };
}

export function getRequiredAdminToken(): string | undefined {
  const value = process.env.HIVEPLANE_ADMIN_TOKEN;
  if (!value) return undefined;
  return value;
}

export function isAuthRequired(): boolean {
  // Default false during v0.0.x; flip to true in v0.1.
  const value = process.env.HIVEPLANE_AUTH_REQUIRED;
  if (!value) return false;
  return value === "true" || value === "1";
}
