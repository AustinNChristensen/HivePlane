import { createHash, randomBytes, randomInt, verify, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";

const BOOTSTRAP_TOKEN_PREFIX = "hp_boot_";
const PAIRING_KEY_PREFIX = "hp_pair_";
const SESSION_TOKEN_PREFIX = "hp_sess_";

/**
 * Crockford base32 alphabet (no `0/O/1/I/L/U`). Pairing keys are read aloud and
 * typed by hand, so we want a character set that resists OCR-style mistakes.
 * 8 chars from this 32-char alphabet ≈ 40 bits of entropy, which is acceptable
 * given (a) short TTL and (b) the rate-limits enforced by the Hive server.
 */
export const PAIRING_KEY_ALPHABET = "23456789ABCDEFGHJKMNPQRSTVWXYZ"; // 30 chars (drops 0/O/1/I/L/U)
export const PAIRING_KEY_LENGTH = 8;
export const PAIRING_KEY_DEFAULT_TTL_MS = 15 * 60 * 1000;

export type BootstrapTokenRecord = {
  tokenId: string;
  tokenHash: string;
  expiresAt: Date;
  beeName?: string;
  labels: Record<string, string>;
  consumedAt?: Date;
  consumedByBeeId?: string;
};

/**
 * The Hive holds at most one active PairingKey at a time. Each successful pair
 * consumes the current key (the server rotates immediately after registration);
 * an admin can also rotate manually via the dashboard.
 */
export type PairingKeyRecord = {
  keyId: string;
  /** The displayed key WITHOUT the `hp_pair_` prefix (e.g. "K7RQ2P9X"). */
  code: string;
  /** Hash of the wire form (`hp_pair_K7RQ2P9X`), used for constant-time lookup. */
  tokenHash: string;
  createdAt: Date;
  expiresAt: Date;
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

export function looksLikePairingKey(token: string): boolean {
  return token.startsWith(PAIRING_KEY_PREFIX);
}

export function looksLikeSessionToken(token: string): boolean {
  return token.startsWith(SESSION_TOKEN_PREFIX);
}

/**
 * Generate a fresh pairing key. Returns the displayable code (without prefix),
 * the wire form (`hp_pair_…`), and the hash used for storage lookup.
 */
export function generatePairingKey(): {
  keyId: string;
  code: string;
  rawToken: string;
  tokenHash: string;
} {
  const keyId = `pk_${randomBytes(8).toString("hex")}`;
  let code = "";
  for (let i = 0; i < PAIRING_KEY_LENGTH; i += 1) {
    code += PAIRING_KEY_ALPHABET.charAt(randomInt(PAIRING_KEY_ALPHABET.length));
  }
  const rawToken = `${PAIRING_KEY_PREFIX}${code}`;
  return { keyId, code, rawToken, tokenHash: sha256Hex(rawToken) };
}

/**
 * Format a pairing-key code for human display: "K7RQ2P9X" → "K7RQ-2P9X".
 * Inserts a single dash at the midpoint (or returns the code unchanged if too
 * short to split).
 */
export function formatPairingKeyForDisplay(code: string): string {
  if (code.length < 6) return code;
  const mid = Math.floor(code.length / 2);
  return `${code.slice(0, mid)}-${code.slice(mid)}`;
}

/**
 * Normalize a user-typed pairing key into its canonical wire form.
 *
 * Tolerates: leading/trailing whitespace, the `hp_pair_` prefix or its
 * absence, mixed case, and any combination of dashes / spaces / underscores
 * inside the body. The displayable alphabet is Crockford-style — already
 * chosen to avoid visually-ambiguous glyphs (no `0/O/1/I/L/U`) — so we don't
 * try to be clever about typo-correcting; anything outside the alphabet after
 * normalization is rejected by returning `undefined`.
 */
export function normalizePairingKey(input: string): string | undefined {
  let body = input.trim();
  if (body.toLowerCase().startsWith(PAIRING_KEY_PREFIX)) {
    body = body.slice(PAIRING_KEY_PREFIX.length);
  }
  body = body.replace(/[\s\-_]+/g, "").toUpperCase();
  if (body.length !== PAIRING_KEY_LENGTH) return undefined;
  for (const ch of body) {
    if (!PAIRING_KEY_ALPHABET.includes(ch)) return undefined;
  }
  return `${PAIRING_KEY_PREFIX}${body}`;
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
