import { spawn } from "node:child_process";
import { readHiveOnDiskConfig } from "./config.js";
import { attachPersistence, getDefaultHiveStatePath, loadHiveServerState } from "./persistence.js";
import { createHiveServer } from "./server.js";

const VERSION = "0.0.1";

// Read the on-disk Hive config first so env vars and CLI flags can override
// individual fields below — the precedence is: CLI flag > env var > config
// file > built-in default. This way a service-managed Hive can keep secrets
// in `~/.hiveplane/hive-config.json` (mode 0600) instead of embedding them
// in its launchd plist / systemd unit, while a developer running `pnpm
// --filter @hiveplane/web start` from a checkout can still set
// HIVEPLANE_ADMIN_TOKEN inline and have it win.
const onDiskConfig = readHiveOnDiskConfig();
const resolvedAdminToken = process.env.HIVEPLANE_ADMIN_TOKEN ?? onDiskConfig.adminToken;
const resolvedAuthRequired =
  process.env.HIVEPLANE_AUTH_REQUIRED !== undefined
    ? process.env.HIVEPLANE_AUTH_REQUIRED === "true" || process.env.HIVEPLANE_AUTH_REQUIRED === "1"
    : onDiskConfig.authRequired;

const { host, port, open, persist, statePath } = parseArgs(process.argv.slice(2));

// Reload prior Bee/session/token/job state if a snapshot exists. v0.0.1
// persistence is a debounced JSON file at `<configDir>/hive-state.json`; see
// `apps/web/src/persistence.ts` for the rationale (small fleets, single
// process, atomic rename). SQLite is the right answer for v0.1.
const state = persist ? loadHiveServerState(statePath) : undefined;
const persistor = persist
  ? attachPersistence(state ?? loadHiveServerState(statePath), { filePath: statePath })
  : undefined;

const server = createHiveServer({
  ...(state ? { state } : {}),
  ...(persistor ? { onMutation: persistor.markDirty } : {}),
  ...(resolvedAdminToken ? { adminToken: resolvedAdminToken } : {}),
  ...(resolvedAuthRequired !== undefined ? { authRequired: resolvedAuthRequired } : {}),
});

// Flush pending writes before the process exits. SIGTERM is what launchd /
// systemd send on shutdown; SIGINT is Ctrl-C from --foreground mode.
async function shutdown(signal: string): Promise<void> {
  console.log(`\n[hive] received ${signal}, flushing state...`);
  try {
    await persistor?.stop();
  } catch (error) {
    console.warn(
      `[hive] state flush failed (${error instanceof Error ? error.message : String(error)})`,
    );
  }
  server.close(() => process.exit(0));
  // Belt-and-braces: if Node hangs onto an open keep-alive socket, force exit
  // after a short grace period so we don't block reboot.
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

server.listen(port, host, () => {
  const address = server.address();
  const boundHost = typeof address === "object" && address ? address.address : host;
  const boundPort = typeof address === "object" && address ? address.port : port;

  // Pick a URL the user (or a browser on the same host) can actually visit.
  // 0.0.0.0 / :: aren't navigable; substitute localhost.
  const visitHost =
    boundHost === "0.0.0.0" || boundHost === "::" || boundHost === "" ? "localhost" : boundHost;
  const url = `http://${visitHost}:${boundPort}`;

  console.log(`HivePlane Hive v${VERSION} listening on http://${boundHost}:${boundPort}`);
  console.log(`Dashboard:   ${url}/`);
  console.log(`Health:      ${url}/healthz`);
  console.log(`API root:    ${url}/api/bees`);

  if (open) {
    openInBrowser(`${url}/`);
  }
});

function parseArgs(args: string[]): {
  host: string;
  port: number;
  open: boolean;
  persist: boolean;
  statePath: string;
} {
  let host = process.env.HIVEPLANE_HIVE_HOST ?? onDiskConfig.host ?? "127.0.0.1";
  let port = Number(process.env.HIVEPLANE_HIVE_PORT ?? onDiskConfig.port ?? 8787);
  // Auto-open the browser on interactive (TTY) runs unless explicitly disabled.
  // When the Hive runs under launchd/systemd, stdout isn't a TTY, so this is
  // automatically off without needing the service unit to pass a flag.
  let open =
    parseBoolEnv(process.env.HIVEPLANE_OPEN_BROWSER) ??
    onDiskConfig.openBrowser ??
    Boolean(process.stdout.isTTY);
  // Default-on: a Hive restart should not wipe paired Bees / sessions /
  // tokens / jobs. `--no-persist` exists for ephemeral tests + CI.
  let persist = parseBoolEnv(process.env.HIVEPLANE_PERSIST) ?? true;
  let statePath = process.env.HIVEPLANE_STATE_FILE ?? getDefaultHiveStatePath();

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--") continue;
    if (arg === "--host") host = requireValue(args, ++index, "--host");
    else if (arg === "--port") port = Number(requireValue(args, ++index, "--port"));
    else if (arg === "--open") open = true;
    else if (arg === "--no-open") open = false;
    else if (arg === "--persist") persist = true;
    else if (arg === "--no-persist") persist = false;
    else if (arg === "--state-file") statePath = requireValue(args, ++index, "--state-file");
  }

  if (!Number.isInteger(port) || port <= 0) {
    throw new Error(`Invalid --port: ${port}`);
  }

  return { host, port, open, persist, statePath };
}

function requireValue(args: string[], index: number, flag: string): string {
  const value = args[index];
  if (!value) throw new Error(`${flag} requires a value`);
  return value;
}

function parseBoolEnv(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  if (value === "1" || value.toLowerCase() === "true") return true;
  if (value === "0" || value.toLowerCase() === "false") return false;
  return undefined;
}

function openInBrowser(url: string): void {
  const platform = process.platform;
  const opener =
    platform === "darwin"
      ? { cmd: "open", args: [url] }
      : platform === "win32"
        ? { cmd: "cmd", args: ["/c", "start", "", url] }
        : { cmd: "xdg-open", args: [url] };

  try {
    const child = spawn(opener.cmd, opener.args, { stdio: "ignore", detached: true });
    child.on("error", (err) => {
      // Best-effort. If `open`/`xdg-open` isn't on PATH (headless server,
      // container) just warn — the URL is in the log right above this anyway.
      console.warn(`Could not auto-open browser (${err.message}). Open ${url} manually.`);
    });
    child.unref();
  } catch (err) {
    console.warn(
      `Could not auto-open browser (${err instanceof Error ? err.message : String(err)}). Open ${url} manually.`,
    );
  }
}
