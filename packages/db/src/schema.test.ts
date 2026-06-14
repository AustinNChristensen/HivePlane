import { describe, expect, it } from "vitest";
import {
  beeSubAgents,
  beeSystemAccess,
  bees,
  bootstrapTokens,
  hiveSettings,
  jobEvents,
  jobs,
  localModels,
  modelBackends,
  subAgentDefinitions,
  systems,
  userSystemPermissions,
} from "./schema.js";

describe("schema", () => {
  it("exports core control-plane tables", () => {
    expect(bees).toBeDefined();
    expect(bootstrapTokens).toBeDefined();
    expect(jobs).toBeDefined();
    expect(jobEvents).toBeDefined();
    expect(hiveSettings).toBeDefined();
    expect(systems).toBeDefined();
    expect(userSystemPermissions).toBeDefined();
    expect(beeSystemAccess).toBeDefined();
    expect(subAgentDefinitions).toBeDefined();
    expect(beeSubAgents).toBeDefined();
    expect(modelBackends).toBeDefined();
    expect(localModels).toBeDefined();
  });
});
