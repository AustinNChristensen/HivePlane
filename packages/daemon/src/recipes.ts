import { spawn, type ChildProcess } from "node:child_process";
import { z } from "zod";
import type { JobEvent, JsonValue } from "@hiveplane/protocol";

const CommandStepSchema = z.object({
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  cwd: z.string().optional(),
});

export const RecipeSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  version: z.string().min(1).default("1"),
  description: z.string().optional(),
  steps: z
    .array(
      z.object({
        id: z.string().min(1),
        name: z.string().optional(),
        platforms: z.array(z.string().min(1)).optional(),
        skipIf: CommandStepSchema.optional(),
        run: CommandStepSchema,
        healthcheck: CommandStepSchema.optional(),
      }),
    )
    .min(1),
});

export type Recipe = z.infer<typeof RecipeSchema>;
export type RecipeEvent = {
  level: JobEvent["level"];
  type: string;
  data: Record<string, JsonValue>;
};

export type RecipeExecutionOptions = {
  recipe: Recipe;
  dryRun?: boolean;
  platform?: NodeJS.Platform | string;
  spawnImpl?: typeof spawn;
  signal?: AbortSignal;
  emit?: (event: RecipeEvent) => Promise<void> | void;
};

export type RecipeExecutionResult =
  | { status: "succeeded"; output: Record<string, JsonValue> }
  | { status: "failed"; error: Record<string, JsonValue> }
  | { status: "cancelled"; error: Record<string, JsonValue> };

type CommandResult = {
  exitCode: number;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
};

export async function executeRecipe(
  options: RecipeExecutionOptions,
): Promise<RecipeExecutionResult> {
  const platform = options.platform ?? process.platform;
  const spawnImpl = options.spawnImpl ?? spawn;
  const planned = options.recipe.steps
    .filter((step) => step.platforms === undefined || step.platforms.includes(platform))
    .map((step) => ({
      id: step.id,
      command: step.run.command,
      args: step.run.args,
      hasSkipCheck: step.skipIf !== undefined,
      hasHealthcheck: step.healthcheck !== undefined,
    }));

  await emit(options, "info", "recipe.plan", {
    recipeId: options.recipe.id,
    dryRun: options.dryRun === true,
    steps: planned,
  });

  if (options.dryRun) {
    return {
      status: "succeeded",
      output: { recipeId: options.recipe.id, dryRun: true, plannedSteps: planned },
    };
  }

  const completed: Record<string, JsonValue>[] = [];
  for (const step of options.recipe.steps) {
    if (step.platforms !== undefined && !step.platforms.includes(platform)) {
      await emit(options, "info", "recipe.step.skipped", {
        stepId: step.id,
        reason: "platform_mismatch",
        platform,
      });
      continue;
    }

    if (step.skipIf) {
      const check = await runRecipeCommand(options, spawnImpl, step.id, "skip_check", step.skipIf);
      if (check.kind === "cancelled") return check.outcome;
      if (check.kind === "error") return commandFailure(step.id, "skip_check", check.error);
      if (check.result.exitCode === 0) {
        await emit(options, "info", "recipe.step.skipped", {
          stepId: step.id,
          reason: "idempotency_check_passed",
          stdout: check.result.stdout,
        });
        completed.push({ stepId: step.id, skipped: true });
        continue;
      }
    }

    const run = await runRecipeCommand(options, spawnImpl, step.id, "run", step.run);
    if (run.kind === "cancelled") return run.outcome;
    if (run.kind === "error") return commandFailure(step.id, "run", run.error);
    if (run.result.exitCode !== 0) return commandFailure(step.id, "run", run.result);

    if (step.healthcheck) {
      const health = await runRecipeCommand(
        options,
        spawnImpl,
        step.id,
        "healthcheck",
        step.healthcheck,
      );
      if (health.kind === "cancelled") return health.outcome;
      if (health.kind === "error") return commandFailure(step.id, "healthcheck", health.error);
      if (health.result.exitCode !== 0) {
        return commandFailure(step.id, "healthcheck", health.result);
      }
    }

    completed.push({
      stepId: step.id,
      skipped: false,
      stdout: run.result.stdout,
      stderr: run.result.stderr,
    });
  }

  return { status: "succeeded", output: { recipeId: options.recipe.id, steps: completed } };
}

async function runRecipeCommand(
  options: RecipeExecutionOptions,
  spawnImpl: typeof spawn,
  stepId: string,
  phase: "skip_check" | "run" | "healthcheck",
  command: z.infer<typeof CommandStepSchema>,
): Promise<
  | { kind: "result"; result: CommandResult }
  | { kind: "error"; error: CommandResult & { message: string } }
  | { kind: "cancelled"; outcome: RecipeExecutionResult }
> {
  await emit(options, "info", "recipe.step.start", {
    stepId,
    phase,
    command: command.command,
    args: command.args,
  });

  const child = spawnImpl(command.command, command.args, {
    cwd: command.cwd,
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env,
  });
  const cleanup = attachCancellation(child, options.signal);
  const stdout: string[] = [];
  const stderr: string[] = [];

  child.stdout?.on("data", (data: Buffer) => {
    const text = data.toString("utf8");
    stdout.push(text);
    void emit(options, "debug", "recipe.step.stdout", { stepId, phase, text });
  });
  child.stderr?.on("data", (data: Buffer) => {
    const text = data.toString("utf8");
    stderr.push(text);
    void emit(options, "debug", "recipe.step.stderr", { stepId, phase, text });
  });

  return await new Promise((resolve) => {
    child.once("error", (error) => {
      cleanup();
      resolve({
        kind: "error",
        error: {
          exitCode: -1,
          signal: null,
          stdout: stdout.join(""),
          stderr: stderr.join(""),
          message: error instanceof Error ? error.message : String(error),
        },
      });
    });
    child.once("close", async (exitCode, signal) => {
      cleanup();
      const result = {
        exitCode: exitCode ?? -1,
        signal: signal ?? null,
        stdout: stdout.join(""),
        stderr: stderr.join(""),
      };
      if (signal && options.signal?.aborted) {
        resolve({
          kind: "cancelled",
          outcome: {
            status: "cancelled",
            error: { code: "recipe_cancelled", message: "recipe job was cancelled", stepId },
          },
        });
        return;
      }
      await emit(options, "info", "recipe.step.complete", {
        stepId,
        phase,
        exitCode: result.exitCode,
        signal: result.signal,
      });
      resolve({ kind: "result", result });
    });
  });
}

function commandFailure(
  stepId: string,
  phase: "skip_check" | "run" | "healthcheck",
  result: CommandResult & { message?: string },
): RecipeExecutionResult {
  return {
    status: "failed",
    error: {
      code: "recipe_step_failed",
      message:
        result.message ?? `recipe step ${stepId} ${phase} failed with exit code ${result.exitCode}`,
      stepId,
      phase,
      exitCode: result.exitCode,
      signal: result.signal,
      stdout: result.stdout,
      stderr: result.stderr,
    },
  };
}

async function emit(
  options: RecipeExecutionOptions,
  level: JobEvent["level"],
  type: string,
  data: Record<string, JsonValue>,
): Promise<void> {
  await options.emit?.({ level, type, data });
}

function attachCancellation(child: ChildProcess, signal?: AbortSignal): () => void {
  if (!signal) return () => {};
  const onAbort = () => {
    if (!child.killed) child.kill("SIGTERM");
  };
  signal.addEventListener("abort", onAbort, { once: true });
  return () => signal.removeEventListener("abort", onAbort);
}
