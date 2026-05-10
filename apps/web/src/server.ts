import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BeeHeartbeatSchema, type BeeHeartbeat } from "@hiveplane/protocol";

export type HiveBeeRecord = {
  beeId: string;
  beeName?: string;
  daemonVersion: string;
  status: BeeHeartbeat["status"];
  activeJobs: number;
  firstSeenAt: string;
  lastSeenAt: string;
  heartbeatCount: number;
};

export type HiveServerState = {
  bees: Map<string, HiveBeeRecord>;
};

export type CreateHiveServerOptions = {
  state?: HiveServerState;
  now?: () => Date;
  /** Override directory where install scripts live. Defaults to repo `infra/install`. */
  installScriptsDir?: string;
};

export function createHiveServerState(): HiveServerState {
  return { bees: new Map() };
}

export function upsertBeeHeartbeat(
  state: HiveServerState,
  heartbeat: BeeHeartbeat,
  now = new Date(),
): HiveBeeRecord {
  const existing = state.bees.get(heartbeat.beeId);
  const timestamp = heartbeat.timestamp || now.toISOString();
  const record: HiveBeeRecord = {
    beeId: heartbeat.beeId,
    daemonVersion: heartbeat.daemonVersion,
    status: heartbeat.status,
    activeJobs: heartbeat.activeJobs,
    firstSeenAt: existing?.firstSeenAt ?? timestamp,
    lastSeenAt: timestamp,
    heartbeatCount: (existing?.heartbeatCount ?? 0) + 1,
  };

  state.bees.set(heartbeat.beeId, record);
  return record;
}

function defaultInstallScriptsDir(): string {
  // apps/web/src/server.ts → ../../../infra/install
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, "..", "..", "..", "infra", "install");
}

const INSTALL_SCRIPT_NAMES = new Set(["bee.sh", "hive.sh"]);

export function createHiveServer(options: CreateHiveServerOptions = {}) {
  const state = options.state ?? createHiveServerState();
  const now = options.now ?? (() => new Date());
  const installScriptsDir = options.installScriptsDir ?? defaultInstallScriptsDir();

  return createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://localhost");

      if (request.method === "GET" && url.pathname === "/healthz") {
        return sendJson(response, 200, { ok: true, service: "hiveplane-hive" });
      }

      if (request.method === "GET" && url.pathname === "/api/bees") {
        return sendJson(response, 200, { bees: [...state.bees.values()] });
      }

      if (request.method === "POST" && url.pathname === "/api/bees/heartbeat") {
        const body = await readJson(request);
        const heartbeat = BeeHeartbeatSchema.parse(body);
        const bee = upsertBeeHeartbeat(state, heartbeat, now());
        return sendJson(response, 200, { accepted: true, bee, jobs: [] });
      }

      if (request.method === "GET" && url.pathname.startsWith("/install/")) {
        const name = url.pathname.slice("/install/".length);
        if (!INSTALL_SCRIPT_NAMES.has(name)) {
          return sendJson(response, 404, { error: "not_found" });
        }
        const filePath = join(installScriptsDir, name);
        try {
          const body = readFileSync(filePath, "utf8");
          response.writeHead(200, {
            "content-type": "text/x-shellscript; charset=utf-8",
            "cache-control": "no-store",
          });
          response.end(body);
          return;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            return sendJson(response, 404, { error: "install_script_missing", name });
          }
          throw error;
        }
      }

      return sendJson(response, 404, { error: "not_found" });
    } catch (error) {
      return sendJson(response, 400, {
        error: "bad_request",
        message: error instanceof Error ? error.message : "Unknown error",
      });
    }
  });
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  const rawBody = Buffer.concat(chunks).toString("utf8");
  if (!rawBody) return {};
  return JSON.parse(rawBody);
}

function sendJson(response: ServerResponse, statusCode: number, payload: unknown): void {
  response.writeHead(statusCode, { "content-type": "application/json" });
  response.end(`${JSON.stringify(payload, null, 2)}\n`);
}
