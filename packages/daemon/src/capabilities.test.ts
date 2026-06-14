import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  collectConnectorCapabilities,
  deleteOpenClawSubAgentRegistry,
  getOpenClawSubAgentRegistryPath,
  readAgentSessionRegistry,
  readOpenClawSubAgentRegistry,
  upsertAgentSessionRegistry,
  upsertOpenClawSubAgentRegistry,
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

describe("OpenClaw sub-agent registry", () => {
  it("persists managed sub-agent definitions as Bee capability metadata", () => {
    const dir = newDir();
    upsertOpenClawSubAgentRegistry(
      {
        id: "subagent_123",
        name: "Repo reviewer",
        runtime: "openclaw",
        status: "configured",
        systemId: "dev",
        modelProvider: "ollama",
        model: "gemma4:12b",
        tools: ["github", "filesystem"],
        skills: ["code-review"],
        workingDirectories: ["/repo"],
        updatedAt: "2026-05-09T08:00:00.000Z",
        metadata: { source: "hive" },
      },
      dir,
    );

    expect(getOpenClawSubAgentRegistryPath(dir)).toBe(join(dir, "openclaw-sub-agents.json"));
    expect(readOpenClawSubAgentRegistry(dir)).toEqual([
      expect.objectContaining({
        id: "subagent_123",
        runtime: "openclaw",
        model: "gemma4:12b",
        workingDirectories: ["/repo"],
      }),
    ]);
    expect(deleteOpenClawSubAgentRegistry("subagent_123", dir)).toBe(true);
    expect(readOpenClawSubAgentRegistry(dir)).toEqual([]);
  });
});

describe("connector capabilities", () => {
  it("always reports filesystem as an available connector", () => {
    expect(collectConnectorCapabilities()).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "filesystem", status: "available" })]),
    );
  });
});
