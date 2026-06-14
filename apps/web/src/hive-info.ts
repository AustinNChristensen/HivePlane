import { execFile } from "node:child_process";
import { hostname as osHostname } from "node:os";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * The Hive's "what URL should a Bee actually use to reach me?" answer.
 *
 * Why this isn't just `<bind-host>:<port>`: an operator who opens the
 * dashboard at `http://localhost:4483/dashboard` from their browser on the Hive box
 * has no way to know what URL to give to a Bee on another machine. We
 * detect Tailscale automatically (the recommended HivePlane transport per
 * the README), and otherwise fall back to the machine's hostname.
 *
 * The detection result is cached for the server's lifetime — tailnet
 * membership doesn't change at runtime, and we'd rather not shell out to
 * `tailscale status` on every dashboard refresh.
 */
export type HiveInfo = {
  /**
   * The URL we'd suggest a remote Bee use to reach this Hive. Tailscale
   * MagicDNS name if a tailnet is detected, otherwise `http://<hostname>:<port>`.
   */
  recommendedUrl: string;
  /** What the runtime is actually bound to (from config / env / CLI). */
  bindHost: string;
  bindPort: number;
  /** True iff the Tailscale CLI returned a usable MagicDNS name or IP. */
  tailscaleDetected: boolean;
  /** Alternate URLs worth surfacing (raw Tailscale IP, LAN IP, etc.). */
  alternates: string[];
};

let cached: HiveInfo | undefined;

export async function getHiveInfo(bindHost: string, bindPort: number): Promise<HiveInfo> {
  if (cached) return cached;
  cached = await detectHiveInfo(bindHost, bindPort);
  return cached;
}

/** Clear the cache. Tests only. */
export function _resetHiveInfoCache(): void {
  cached = undefined;
}

async function detectHiveInfo(bindHost: string, bindPort: number): Promise<HiveInfo> {
  const alternates: string[] = [];
  const tailscale = await detectTailscale(bindPort);

  if (tailscale) {
    if (tailscale.ipUrl && tailscale.ipUrl !== tailscale.recommendedUrl) {
      alternates.push(tailscale.ipUrl);
    }
    return {
      recommendedUrl: tailscale.recommendedUrl,
      bindHost,
      bindPort,
      tailscaleDetected: true,
      alternates,
    };
  }

  // No Tailscale — best guess is the machine's hostname. `localhost` and
  // wildcard binds are not useful to a remote Bee, so we substitute the OS
  // hostname (which on macOS gets a `.local` Bonjour suffix when resolved
  // over the LAN).
  const fallbackHost =
    bindHost === "0.0.0.0" ||
    bindHost === "::" ||
    bindHost === "127.0.0.1" ||
    bindHost === "localhost" ||
    bindHost === ""
      ? osHostname()
      : bindHost;

  return {
    recommendedUrl: `http://${fallbackHost}:${bindPort}`,
    bindHost,
    bindPort,
    tailscaleDetected: false,
    alternates,
  };
}

type TailscaleProbe = { recommendedUrl: string; ipUrl?: string };

/**
 * Best-effort `tailscale status --json` lookup. Returns the MagicDNS-based
 * URL if we can find one, plus an IP-based fallback. Returns `undefined`
 * when Tailscale isn't installed, isn't running, or returns a shape we
 * don't recognise — we treat any failure as "no Tailscale on this box".
 */
async function detectTailscale(port: number): Promise<TailscaleProbe | undefined> {
  try {
    const { stdout } = await execFileAsync("tailscale", ["status", "--json"], {
      timeout: 1500,
    });
    const parsed = JSON.parse(stdout) as {
      Self?: { DNSName?: string; TailscaleIPs?: string[]; Online?: boolean };
    };
    const dns = (parsed.Self?.DNSName ?? "").replace(/\.$/, "");
    const ipv4 = parsed.Self?.TailscaleIPs?.find((ip) => !ip.includes(":"));
    if (!dns && !ipv4) return undefined;
    const recommendedUrl = dns ? `http://${dns}:${port}` : `http://${ipv4}:${port}`;
    return {
      recommendedUrl,
      ...(ipv4 ? { ipUrl: `http://${ipv4}:${port}` } : {}),
    };
  } catch {
    return undefined;
  }
}
