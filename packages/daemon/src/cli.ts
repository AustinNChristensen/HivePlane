import { BeeConnectionManager, HttpBeeConnectionTransport } from "./connection.js";
import { createDaemonState } from "./index.js";
import { loadOrCreateBeeIdentity } from "./identity.js";

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
  const state = createDaemonState({
    beeId: identity.beeId ?? identity.fingerprint,
    ...(options.name ? { beeName: options.name } : {}),
    hiveUrl: options.hiveUrl,
    heartbeatIntervalSeconds: options.intervalSeconds,
    labels: {},
    maxConcurrentJobs: 1,
  });
  const transport = new HttpBeeConnectionTransport({ hiveUrl: options.hiveUrl });
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

  if (!hiveUrl) {
    throw new Error("Missing required --hive-url or HIVEPLANE_HIVE_URL");
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
    `HivePlane Bee daemon v${VERSION}\n\nUsage:\n  pnpm --filter @hiveplane/daemon start -- --hive-url http://hive.tailnet.ts.net:8787 --name mac-mini\n\nOptions:\n  --hive-url <url>      Hive control-plane URL, usually the Tailscale URL\n  --name <name>         Friendly Bee name for logs\n  --config-dir <path>   Config/identity directory, defaults to ~/.hiveplane\n  --interval <seconds>  Heartbeat interval, defaults to 10\n  --once                Send one heartbeat and exit\n`,
  );
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
