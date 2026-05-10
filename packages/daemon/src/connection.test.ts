import { describe, expect, it, vi } from "vitest";
import type { BeeHeartbeat } from "@hiveplane/protocol";
import {
  BeeConnectionManager,
  HttpBeeConnectionTransport,
  type BeeConnectionTransport,
} from "./connection.js";
import { createDaemonState } from "./index.js";

function createTestState() {
  return createDaemonState({
    beeId: "bee_test",
    beeName: "test-bee",
    hiveUrl: "https://hive.example.com",
    heartbeatIntervalSeconds: 30,
    labels: {},
    maxConcurrentJobs: 1,
  });
}

describe("BeeConnectionManager", () => {
  it("sends heartbeats and dispatches queued jobs", async () => {
    const seenHeartbeats: BeeHeartbeat[] = [];
    const jobs = [
      {
        id: "job_1",
        type: "run_healthcheck" as const,
        beeId: "bee_test",
        status: "assigned" as const,
        payload: { depth: "quick" },
        createdAt: "2026-05-09T20:00:00.000Z",
      },
    ];
    const transport: BeeConnectionTransport = {
      async postHeartbeat(heartbeat) {
        seenHeartbeats.push(heartbeat);
        return { accepted: true, jobs };
      },
    };
    const onJobs = vi.fn();
    const statuses: string[] = [];
    const manager = new BeeConnectionManager({
      state: createTestState(),
      transport,
      daemonVersion: "0.0.0-test",
      onJobs,
      onStatusChange: (status) => statuses.push(status),
    });

    const response = await manager.sendHeartbeat();

    expect(response.jobs).toEqual(jobs);
    expect(onJobs).toHaveBeenCalledWith(jobs);
    expect(seenHeartbeats).toHaveLength(1);
    expect(seenHeartbeats[0]).toMatchObject({
      type: "bee.heartbeat",
      beeId: "bee_test",
      status: "online",
    });
    expect(manager.status).toBe("connected");
    expect(statuses).toEqual(["connecting", "connected"]);
  });

  it("tracks failed heartbeats so the run loop can back off", async () => {
    const manager = new BeeConnectionManager({
      state: createTestState(),
      transport: {
        async postHeartbeat() {
          throw new Error("network down");
        },
      },
      daemonVersion: "0.0.0-test",
    });

    await expect(manager.sendHeartbeat()).rejects.toThrow("network down");
    expect(manager.status).toBe("connecting");
  });
});

describe("HttpBeeConnectionTransport", () => {
  it("posts heartbeat JSON to the Hive heartbeat endpoint", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({
        accepted: true,
        jobs: [],
      }),
    );
    const fetchImpl = fetchMock as unknown as typeof fetch;
    const transport = new HttpBeeConnectionTransport({
      hiveUrl: "https://hive.example.com/base",
      fetchImpl,
    });

    await transport.postHeartbeat({
      type: "bee.heartbeat",
      beeId: "bee_test",
      timestamp: "2026-05-09T20:00:00.000Z",
      daemonVersion: "0.0.0-test",
      status: "online",
      activeJobs: 0,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit];
    expect(url.toString()).toBe("https://hive.example.com/api/bees/heartbeat");
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({ "content-type": "application/json" });
  });

  it("throws on non-2xx responses", async () => {
    const transport = new HttpBeeConnectionTransport({
      hiveUrl: "https://hive.example.com",
      fetchImpl: vi.fn(
        async () => new Response("nope", { status: 503, statusText: "Unavailable" }),
      ) as unknown as typeof fetch,
    });

    await expect(
      transport.postHeartbeat({
        type: "bee.heartbeat",
        beeId: "bee_test",
        timestamp: "2026-05-09T20:00:00.000Z",
        daemonVersion: "0.0.0-test",
        status: "online",
        activeJobs: 0,
      }),
    ).rejects.toThrow("Hive heartbeat failed: 503 Unavailable");
  });
});
