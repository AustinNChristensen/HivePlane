import { sign as edSign } from "node:crypto";
import { readFileSync } from "node:fs";
import { BeeConnectionManager, HttpBeeConnectionTransport } from "./connection.js";
import { readHivePlaneConfig } from "./config.js";
import { createDaemonState } from "./index.js";
import { loadOrCreateBeeIdentity } from "./identity.js";
import { isSessionExpired, readHiveSession } from "./session.js";

const VERSION = "0.0.1";

type BeeCliOptions = {
  hiveUrl: string;
  name?: string;
  configDir?: string;
  intervalSeconds: number;
  once: boolean;
};

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const identity = await loadOrCreateBeeIdentity(
    options.configDir ? { configDir: options.configDir } : {},
  );

  // If a session was created via `hive login --token <bootstrap>`, use the
  // server-issued beeId; otherwise fall back to the public-key fingerprint
  // (legacy unauthenticated mode).
  const session = readHiveSession(options.configDir);
  const sessionUsable =
    session && session.hiveUrl === options.hiveUrl && !isSessionExpired(session);
  if (session && !sessionUsable) {
    if (session.hiveUrl !== options.hiveUrl) {
      console.warn(`[bee] stored session is for ${session.hiveUrl}; ignoring`);
    } else {
      console.warn(`[bee] stored session expired at ${session.sessionExpiresAt}; ignoring`);
    }
  }
  const beeId = sessionUsable ? session.beeId : (identity.beeId ?? identity.fingerprint);

  const state = createDaemonState({
    beeId,
    ...(options.name ? { beeName: options.name } : {}),
    hiveUrl: options.hiveUrl,
    heartbeatIntervalSeconds: options.intervalSeconds,
    labels: {},
    maxConcurrentJobs: 1,
  });

  // Sign every heartbeat body with the Bee's Ed25519 private key when a
  // session exists; pass the session token so the Hive can correlate.
  const authHeaderProvider = sessionUsable
    ? (rawBody: Uint8Array) => {
        const privateKeyPem = readFileSync(identity.privateKeyPath, "utf8");
        const signature = edSign(null, Buffer.from(rawBody), privateKeyPem).toString("base64url");
        return {
          authorization: `Bearer ${session.sessionToken}`,
          "x-bee-signature": signature,
        };
      }
    : undefined;

  const transport = new HttpBeeConnectionTransport({
    hiveUrl: options.hiveUrl,
    ...(authHeaderProvider ? { authHeaderProvider } : {}),
  });
  const manager = new BeeConnectionManager({
    state,
    transport,
    daemonVersion: VERSION,
    heartbeatIntervalMs: options.intervalSeconds * 1000,
    onStatusChange: (status) => console.log(`[bee] status=${status}`),
    onJobs: (jobs) => console.log(`[bee] received ${jobs.length} job(s)`),
    onError: (error) =>
      console.error(`[bee] ${error instanceof Error ? error.message : String(error)}`),
  });

  console.log(`[bee] id=${state.beeId}`);
  console.log(`[bee] hive=${options.hiveUrl}`);
  console.log(`[bee] auth=${sessionUsable ? "signed (session)" : "anonymous"}`);

  if (options.once) {
    const response = await manager.sendHeartbeat();
    console.log(`[bee] heartbeat accepted=${response.accepted} jobs=${response.jobs.length}`);
    return;
  }

  process.once("SIGINT", () => manager.stop());
  process.once("SIGTERM", () => manager.stop());
  await manager.start();
}

function parseArgs(args: string[]): BeeCliOptions {
  let hiveUrl = process.env.HIVEPLANE_HIVE_URL;
  let name = process.env.HIVEPLANE_BEE_NAME;
  let configDir = process.env.HIVEPLANE_CONFIG_DIR;
  let intervalSeconds = Number(process.env.HIVEPLANE_HEARTBEAT_SECONDS ?? 10);
  let once = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--") continue;
    if (arg === "--hive-url") hiveUrl = requireValue(args, ++index, "--hive-url");
    else if (arg === "--name") name = requireValue(args, ++index, "--name");
    else if (arg === "--config-dir") configDir = requireValue(args, ++index, "--config-dir");
    else if (arg === "--interval")
      intervalSeconds = Number(requireValue(args, ++index, "--interval"));
    else if (arg === "--once") once = true;
    else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  // Fall back to ~/.hiveplane/config.json (written by `hive login`).
  if (!hiveUrl || !name) {
    const stored = readHivePlaneConfig(configDir);
    if (!hiveUrl) hiveUrl = stored.hiveUrl;
    if (!name && stored.beeName) name = stored.beeName;
    if (
      Number.isFinite(stored.heartbeatIntervalSeconds) &&
      !process.env.HIVEPLANE_HEARTBEAT_SECONDS &&
      !args.includes("--interval")
    ) {
      intervalSeconds = stored.heartbeatIntervalSeconds ?? intervalSeconds;
    }
  }

  if (!hiveUrl) {
    throw new Error(
      "No Hive URL configured. Run `hive login <url>` or pass --hive-url / HIVEPLANE_HIVE_URL.",
    );
  }
  if (!Number.isInteger(intervalSeconds) || intervalSeconds <= 0) {
    throw new Error(`Invalid --interval: ${intervalSeconds}`);
  }

  return {
    hiveUrl,
    ...(name ? { name } : {}),
    ...(configDir ? { configDir } : {}),
    intervalSeconds,
    once,
  };
}

function requireValue(args: string[], index: number, flag: string): string {
  const value = args[index];
  if (!value) throw new Error(`${flag} requires a value`);
  return value;
}

function printHelp(): void {
  console.log(
    `HivePlane Bee daemon v${VERSION}\n\nUsage:\n  hiveplane-bee                                     # uses ~/.hiveplane/config.json\n  hiveplane-bee --hive-url http://hive.example     # explicit URL\n\nOptions:\n  --hive-url <url>      Hive URL (overrides config.json). Usually the Tailscale URL.\n  --name <name>         Friendly Bee name for logs\n  --config-dir <path>   Config/identity directory, defaults to ~/.hiveplane\n  --interval <seconds>  Heartbeat interval, defaults to 10\n  --once                Send one heartbeat and exit\n`,
  );
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
