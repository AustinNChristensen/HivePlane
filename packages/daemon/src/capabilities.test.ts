import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  readAgentSessionRegistry,
  upsertAgentSessionRegistry,
  getAgentSessionRegistryPath,
} from "./capabilities.js";

function newDir() {
  return mkdtempSync(join(tmpdir(), "hp-capabilities-test-"));
}

describe("agent session registry", () => {
  it("persists recent agent sessions as Bee capability metadata", () => {
    const dir = newDir();
    upsertAgentSessionRegistry(
      {
        id: "hiveplane-task-task_123",
        runtime: "openclaw",
        label: "Summarize repo",
        status: "recent",
        taskId: "task_123",
        workingDirectory: "/repo",
        updatedAt: "2026-05-09T08:00:00.000Z",
        metadata: { jobId: "job_123" },
      },
      dir,
    );

    expect(getAgentSessionRegistryPath(dir)).toBe(join(dir, "agent-sessions.json"));
    expect(readAgentSessionRegistry(dir)).toEqual([
      expect.objectContaining({
        id: "hiveplane-task-task_123",
        runtime: "openclaw",
        workingDirectory: "/repo",
      }),
    ]);
  });
});
