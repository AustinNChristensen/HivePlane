import { describe, expect, it } from "vitest";
import { bees, bootstrapTokens, hiveSettings, jobEvents, jobs } from "./schema.js";

describe("schema", () => {
  it("exports core control-plane tables", () => {
    expect(bees).toBeDefined();
    expect(bootstrapTokens).toBeDefined();
    expect(jobs).toBeDefined();
    expect(jobEvents).toBeDefined();
    expect(hiveSettings).toBeDefined();
  });
});
