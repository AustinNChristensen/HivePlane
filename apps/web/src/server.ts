import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
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

export function createHiveServer(options: CreateHiveServerOptions = {}) {
  const state = options.state ?? createHiveServerState();
  const now = options.now ?? (() => new Date());

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
