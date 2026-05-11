import { execFileSync } from "node:child_process";

/**
 * Probe whether anything is currently listening on the given TCP port. We
 * shell out to `lsof` (macOS, most Linux distros) and fall back to `ss`
 * (Linux without lsof). On Windows / minimal containers without either,
 * returns `null` rather than `false` so callers can distinguish "couldn't
 * check" from "definitely free".
 *
 * The output is captured raw so callers can include it in error messages —
 * an operator who sees `node 7616 chris … TCP 127.0.0.1:4483 (LISTEN)`
 * has everything they need to track down the squatter.
 */
export type PortProbeResult =
  | { listening: true; details: string }
  | { listening: false; details: "" }
  | { listening: null; details: "" };

export function probePortInUse(port: number): PortProbeResult {
  if (canExec("lsof")) {
    try {
      const out = execFileSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN"], {
        stdio: ["ignore", "pipe", "ignore"],
        encoding: "utf8",
      }).trim();
      return out ? { listening: true, details: out } : { listening: false, details: "" };
    } catch (err) {
      // lsof exits non-zero with empty stdout when the port is free, which
      // execFileSync turns into a thrown error. Treat that as "free".
      const stdout = (err as { stdout?: Buffer | string }).stdout?.toString().trim() ?? "";
      return stdout ? { listening: true, details: stdout } : { listening: false, details: "" };
    }
  }

  if (canExec("ss")) {
    try {
      const out = execFileSync("ss", ["-ltnH", `sport = :${port}`], {
        stdio: ["ignore", "pipe", "ignore"],
        encoding: "utf8",
      }).trim();
      return out ? { listening: true, details: out } : { listening: false, details: "" };
    } catch {
      return { listening: false, details: "" };
    }
  }

  return { listening: null, details: "" };
}

/**
 * Probe `<host>:<port>/version` and check whether the response identifies
 * itself as our Hive. Used by `hive selfhost status` to surface the case
 * where the launchd unit is "running" but a different process is what's
 * actually answering on the bound port (the v0.0.2 → v0.0.3 collision
 * scenario).
 *
 * Returns:
 *   - { kind: "hive", version }       — the listener IS us
 *   - { kind: "stranger", body }      — something answered, but not us
 *   - { kind: "unreachable", reason } — connection refused / timeout / DNS
 */
export type VersionProbeResult =
  | { kind: "hive"; version: string }
  | { kind: "stranger"; body: string }
  | { kind: "unreachable"; reason: string };

export async function probeHiveVersion(
  host: string,
  port: number,
  options: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<VersionProbeResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 1500;
  // 0.0.0.0 / :: aren't navigable — substitute localhost so the probe goes
  // somewhere meaningful. The Hive listens on the wildcard but localhost is
  // the loopback address an operator running `hive selfhost status` would
  // hit.
  const reachableHost = host === "0.0.0.0" || host === "::" || host === "" ? "127.0.0.1" : host;
  const url = `http://${reachableHost}:${port}/version`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { signal: controller.signal });
    const text = await res.text();
    try {
      const parsed = JSON.parse(text) as { service?: unknown; version?: unknown };
      if (parsed.service === "hiveplane-hive" && typeof parsed.version === "string") {
        return { kind: "hive", version: parsed.version };
      }
    } catch {
      // not JSON — fall through to "stranger"
    }
    // truncate body so a chatty 404 page doesn't blow up status output
    const trimmed = text.length > 200 ? `${text.slice(0, 200)}…` : text;
    return { kind: "stranger", body: trimmed };
  } catch (err) {
    return {
      kind: "unreachable",
      reason: err instanceof Error ? err.message : String(err),
    };
  } finally {
    clearTimeout(timer);
  }
}

function canExec(bin: string): boolean {
  try {
    execFileSync("which", [bin], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
