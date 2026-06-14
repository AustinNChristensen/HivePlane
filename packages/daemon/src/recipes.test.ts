import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { executeRecipe, RecipeSchema } from "./recipes.js";

class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  killed = false;
}

function makeSpawn(exitCode: number, stdout = "", stderr = "") {
  return vi.fn(() => {
    const child = new FakeChild();
    setImmediate(() => {
      if (stdout) child.stdout.emit("data", Buffer.from(stdout));
      if (stderr) child.stderr.emit("data", Buffer.from(stderr));
      child.emit("close", exitCode, null);
    });
    return child as unknown as ReturnType<typeof import("node:child_process").spawn>;
  });
}

describe("recipe engine", () => {
  it("validates the checked-in safe example recipe", () => {
    const here = fileURLToPath(import.meta.url);
    const fixture = join(here, "..", "..", "..", "..", "infra", "recipes", "safe-example.json");
    const recipe = RecipeSchema.parse(JSON.parse(readFileSync(fixture, "utf8")));

    expect(recipe.id).toBe("safe-example");
    expect(recipe.steps[0]?.id).toBe("node-version");
  });

  it("skips platform-specific steps that do not match", async () => {
    const events: string[] = [];
    const spawnImpl = makeSpawn(0);

    const result = await executeRecipe({
      platform: "linux",
      spawnImpl: spawnImpl as unknown as typeof import("node:child_process").spawn,
      recipe: {
        id: "mac-only",
        name: "Mac only",
        version: "1",
        steps: [{ id: "mac", platforms: ["darwin"], run: { command: "echo", args: ["hi"] } }],
      },
      emit: (event) => {
        events.push(event.type);
      },
    });

    expect(result.status).toBe("succeeded");
    expect(spawnImpl).not.toHaveBeenCalled();
    expect(events).toContain("recipe.step.skipped");
  });

  it("returns structured errors for failed steps", async () => {
    const result = await executeRecipe({
      spawnImpl: makeSpawn(
        42,
        "",
        "nope\n",
      ) as unknown as typeof import("node:child_process").spawn,
      recipe: {
        id: "fail-example",
        name: "Fail example",
        version: "1",
        steps: [{ id: "install", run: { command: "false", args: [] } }],
      },
    });

    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.error).toMatchObject({
        code: "recipe_step_failed",
        stepId: "install",
        phase: "run",
        exitCode: 42,
      });
      expect(result.error.stderr).toContain("nope");
    }
  });
});
