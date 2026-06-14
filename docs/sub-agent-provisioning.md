# Sub-Agent Provisioning Model

HivePlane should treat OpenClaw, Hermes, Codex CLI, local model workers, and future runtimes as managed runtime targets on Bees. A sub-agent definition is desired state in the Hive; adapters reconcile that desired state into runtime-specific local config.

## Desired Definition

```ts
type SubAgentDefinition = {
  id: string;
  organizationId: string;
  systemId: string;
  name: string;
  runtime: "openclaw" | "hermes" | "codex" | string;
  modelProvider?: string;
  model?: string;
  tools: string[];
  skills: string[];
  workingDirectories: string[];
  environmentRefs: string[];
  policyProfileId?: string;
  targetBeeIds?: string[];
  enabled: boolean;
};
```

The definition is portable desired state. The Bee adapter decides whether and how it can apply that definition to the local runtime.

## Discovered Runtime State

Each Bee reports:

- installed runtimes;
- runtime versions;
- runtime health;
- configured sub-agents;
- available local model backends and models;
- adapter capabilities: `list`, `create`, `update`, `delete`, `smokeTest`;
- config paths the adapter is allowed to manage.

## Adapter Contract

A runtime adapter should expose:

- `detect()`: runtime installed/version/health;
- `listSubAgents()`: discovered local config;
- `applySubAgent(definition)`: create or update within allowed config paths;
- `deleteSubAgent(id)`: remove adapter-managed config only;
- `smokeTest(definition)`: verify the sub-agent can respond;
- `status()`: normalized runtime status for health/capability reporting.

Adapters must not edit outside allowlisted runtime config paths. If a runtime lacks a stable config API, the adapter should report read-only capability instead of guessing.

## OpenClaw

OpenClaw is the first target:

- Hive task requirements can specify `runtimes: ["openclaw"]`;
- Bee reports OpenClaw capability when the binary is present;
- `agent_task` jobs can invoke `openclaw agent --json`;
- future OpenClaw provisioning should manage named sub-agent config, model selection, tool/skill grants, and smoke tests.

## Hermes

Hermes follows the same desired-state model but may expose different config files, runtimes, or session semantics. The adapter should normalize the surface area back into HivePlane's definition/state shape.

## Routing

Hive can route a task to:

- any Bee with a compatible runtime;
- a specific sub-agent id;
- a Bee with a required model/backend;
- a Bee with access to the task's target System;
- a Bee whose operational state is healthy enough for the task.

## Lifecycle

1. Operator creates or updates desired sub-agent definition.
2. Hive queues a reconcile job for eligible Bees.
3. Bee adapter validates local runtime/config path support.
4. Bee applies config or returns a clear unsupported/error result.
5. Bee runs smoke test if supported.
6. Hive stores discovered state and exposes routeable capabilities.

## Safety

- Desired definitions reference secret/environment handles, not raw secret values.
- Runtime adapters manage only explicit config paths.
- Any destructive delete or credential change requires approval.
- Smoke tests should be bounded and non-destructive.

## Acceptance Signal

An operator should be able to define an `openclaw` sub-agent for the `dev` System, assign it a model and working directory, reconcile it onto a Bee, see it in Bee capabilities, and route a task directly to it.
