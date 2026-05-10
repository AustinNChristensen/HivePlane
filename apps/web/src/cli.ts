import { spawn } from "node:child_process";
import { createHiveServer } from "./server.js";

const VERSION = "0.0.1";

const { host, port, open } = parseArgs(process.argv.slice(2));
const server = createHiveServer();

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

function parseArgs(args: string[]): { host: string; port: number; open: boolean } {
  let host = process.env.HIVEPLANE_HIVE_HOST ?? "127.0.0.1";
  let port = Number(process.env.HIVEPLANE_HIVE_PORT ?? 8787);
  // Auto-open the browser on interactive (TTY) runs unless explicitly disabled.
  // When the Hive runs under launchd/systemd, stdout isn't a TTY, so this is
  // automatically off without needing the service unit to pass a flag.
  let open = parseBoolEnv(process.env.HIVEPLANE_OPEN_BROWSER) ?? Boolean(process.stdout.isTTY);

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--") continue;
    if (arg === "--host") host = requireValue(args, ++index, "--host");
    else if (arg === "--port") port = Number(requireValue(args, ++index, "--port"));
    else if (arg === "--open") open = true;
    else if (arg === "--no-open") open = false;
  }

  if (!Number.isInteger(port) || port <= 0) {
    throw new Error(`Invalid --port: ${port}`);
  }

  return { host, port, open };
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
