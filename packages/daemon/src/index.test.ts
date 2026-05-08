import { describe, expect, it } from "vitest";
import { createDaemonState, createHeartbeat, DaemonConfigSchema } from "./index.js";

describe("daemon config", () => {
  it("applies defaults", () => {
    const config = DaemonConfigSchema.parse({
      hiveUrl: "https://cloud.hiveplane.com",
    });

    expect(config.heartbeatIntervalSeconds).toBe(30);
    expect(config.maxConcurrentJobs).toBe(1);
  });
});

describe("daemon state", () => {
  it("creates Bee state and heartbeat", () => {
    const state = createDaemonState({
      beeId: "bee_test",
      beeName: "test-bee",
      hiveUrl: "https://cloud.hiveplane.com",
      heartbeatIntervalSeconds: 30,
      labels: {},
      maxConcurrentJobs: 1,
    });

    const heartbeat = createHeartbeat(state, "0.0.0-test");

    expect(state.beeId).toBe("bee_test");
    expect(heartbeat.type).toBe("bee.heartbeat");
    expect(heartbeat.beeId).toBe("bee_test");
    expect(heartbeat.status).toBe("online");
  });
});
