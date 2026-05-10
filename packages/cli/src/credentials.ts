/**
 * Pure helpers for `hive login`'s credential parsing — kept separate from
 * `index.ts` so unit tests don't have to pull the whole daemon into vitest's
 * resolver.
 */

export type ClassifiedCredential =
  | { kind: "bootstrap"; value: string }
  | { kind: "pairing"; value: string };

/**
 * Decide whether a typed credential looks like a long bootstrap token or a
 * short pairing key, and normalize the latter to its canonical wire form
 * (uppercase, dashes/whitespace stripped, `hp_pair_` prefix added). Returns
 * `undefined` if the input doesn't match either shape.
 *
 * The pairing-key alphabet here mirrors the server-side Crockford-base32
 * choice (no `0/O/1/I/L/U`); typing one of those characters is a hard error
 * so the operator notices the mismatch immediately rather than firing an
 * impossible auth attempt at the Hive.
 */
export function classifyCredential(input: string): ClassifiedCredential | undefined {
  const trimmed = input.trim();
  if (!trimmed) return undefined;

  if (trimmed.toLowerCase().startsWith("hp_boot_")) {
    return { kind: "bootstrap", value: trimmed };
  }

  // Pairing key: tolerate the `hp_pair_` prefix, mixed case, and the dash
  // separator the dashboard injects for readability.
  let body = trimmed;
  if (body.toLowerCase().startsWith("hp_pair_")) {
    body = body.slice("hp_pair_".length);
  }
  body = body.replace(/[\s\-_]+/g, "").toUpperCase();
  if (body.length === 8 && /^[2-9A-HJKMNP-TV-Z]+$/.test(body)) {
    return { kind: "pairing", value: `hp_pair_${body}` };
  }

  return undefined;
}
