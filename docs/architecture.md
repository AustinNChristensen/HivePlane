# Architecture

HivePlane has two primary sides:

1. **Control plane** — web/API service that manages users, orgs, nodes, agents, jobs, policies, approvals, logs, and audit history.
2. **Worker node daemon** — local process installed on machines that executes jobs, installs/configures runtimes, manages models, accepts scoped sub-agent tasks, and enforces local policy.

## High-Level Diagram

```text
┌─────────────────────────────────────────────────────────────┐
│                    HivePlane Control Plane                  │
│ Dashboard, API, auth, orgs, nodes, agents, tasks, approvals  │
└───────────────▲───────────────────────────────┬─────────────┘
                │ outbound WebSocket/HTTPS      │ REST/API
                │                               │
┌───────────────┴───────────────────────────────▼─────────────┐
│                       Worker Node Daemon                    │
│ device identity, job runner, sub-agent tasks, adapters,      │
│ service manager, model manager, health reporter, policy      │
└───────────────▲─────────────────────────────────────────────┘
                │
      ┌─────────┼────────────┬───────────────┬──────────────┐
      │         │            │               │              │
  OpenClaw    Hermes       Ollama/MLX       Files/Shell     Network
  Gateway     Runtime      Local Models     Tools           Mesh/Relay
```

## Core Design Principle

The control plane coordinates. The worker node decides what is allowed locally.

This means local policy enforcement must live inside the daemon. A compromised or buggy cloud service should not be able to blindly execute arbitrary dangerous actions on a node.

## Bee As Sub-Agent Seat

A Bee is not only an endpoint to monitor. It is an assignable execution seat for the Hive.

The Hive can assign scoped tasks to Bee computers when the Bee has:

- a compatible agent runtime, such as OpenClaw, Hermes, Codex CLI, or a future worker;
- the required skills/capabilities;
- permission to use the needed files, apps, gateways, models, or external APIs;
- a healthy operational state;
- enough availability for the task's expected duration.

This creates a hierarchy:

```text
Hive
  ├─ Bee: Chris Mac mini
  │    ├─ Runtime: OpenClaw
  │    ├─ Runtime: Hermes
  │    ├─ Models: Ollama / local models
  │    └─ Skills: local tools, apps, connectors
  ├─ Bee: Austin MBP
  │    ├─ Runtime: local coding agent
  │    └─ Skills: repo/browser/local app access
  └─ Bee: office/server node
       ├─ Runtime: support agent
       └─ Skills: company systems
```

The Hive should route tasks by matching request requirements to Bee capabilities:

1. Human or agent requests a task.
2. Hive checks user, agent, machine, and skill permissions.
3. Hive selects candidate Bees by availability, health, runtime, skills, data locality, and risk.
4. Hive creates a scoped task/job for the selected Bee.
5. Bee evaluates local policy before execution.
6. Bee runs the task through the selected runtime or tool.
7. Hive records logs, outputs, events, approvals, and follow-up work.
8. If the Bee fails mid-task, Hive applies recovery policy or reassigns the task.

The task scheduler should never treat all Bees as equivalent generic workers. A laptop Bee, local-model server, customer-support box, and finance-connected machine should have different permissions, expectations, and routing behavior.

### Work Context And Session Continuity

Tasks and jobs can carry lightweight work context: agent session id, runtime, working directory, file references, artifact references, and metadata. Bees report recent agent sessions as capabilities, so follow-up work can route back to the machine that already has the relevant repo, model, or agent session warm.

This context is metadata-first. The daemon should not scrape or upload private files by default; richer evidence belongs in explicit artifact flows.

### OpenClaw Task Adapter

The first concrete sub-agent runtime adapter is OpenClaw:

- Hive task requirements can include `runtimes: ["openclaw"]`.
- The scheduler only assigns that task to a healthy Bee that reports OpenClaw capability.
- The Bee daemon invokes `openclaw agent --json` with a dedicated `hiveplane-task-<taskId>` session key.
- The prompt includes the Hive task title, instructions, requester, and requirements.
- stdout/stderr stream back as job events, and the final OpenClaw JSON/text result is stored on the job output.
- The OpenClaw run does not use `--deliver`; HivePlane owns delivery of the result or escalation.

This is intentionally runtime-specific instead of a generic shell escape hatch. Each runtime adapter should expose a small, auditable contract that Hive can route to and reason about.

## Key Components

| Component        | Responsibility                                             |
| ---------------- | ---------------------------------------------------------- |
| Web dashboard    | Manage nodes, agents, jobs, approvals, logs, and settings  |
| API service      | CRUD APIs, auth checks, job queue, event ingestion         |
| Coordinator      | Maintains outbound node connections and dispatches jobs    |
| Task scheduler   | Assigns Hive tasks to healthy, permitted Bee sub-agents    |
| Worker daemon    | Executes node jobs/tasks and streams events                |
| Recipe engine    | Installs/configures software like OpenClaw, Hermes, Ollama |
| Runtime adapters | Manage OpenClaw, Hermes, and future agent runtimes         |
| Model adapters   | Manage local model backends like Ollama and MLX            |
| Policy engine    | Allows, denies, or pauses actions for approval             |
| Audit log        | Records security-relevant changes and approvals            |

## Communication Model

Worker nodes establish outbound connections to the control plane.

MVP transport:

- HTTPS REST for registration and CRUD operations.
- WebSocket for daemon heartbeat, job assignment, event streaming, and approval resolution.
- SSE or WebSocket for browser log streaming.

## Data Flow: Provision a Fresh Node

1. User creates a bootstrap token in HivePlane.
2. User runs bootstrap command on the target machine.
3. Installer downloads daemon and creates local keypair.
4. Daemon registers with bootstrap token.
5. Control plane stores node public key and metadata.
6. Daemon starts heartbeat.
7. Control plane assigns provisioning jobs.
8. Daemon installs/configures runtimes and reports capabilities.

## Data Flow: Execute a Runtime Configuration Job

1. User requests “install OpenClaw and configure Ollama model.”
2. Control plane creates a node job.
3. Node daemon receives job over outbound connection.
4. Daemon evaluates local policy.
5. If approval is needed, daemon pauses and emits approval request.
6. User approves/denies in dashboard or CLI.
7. Daemon executes recipe steps.
8. Logs stream back to control plane.
9. Healthcheck verifies final state.
10. Job completes with durable audit trail.

## Data Flow: Delegate An Agent Task To A Bee

1. User asks the Hive to do work, such as research, code, summarize, call an API, or run a local workflow.
2. Hive turns the request into a scoped task with required capabilities, data access, runtime needs, and risk level.
3. Hive filters Bees by operational state, runtime health, declared capabilities, user/machine/skill permissions, and active workload.
4. Hive assigns the task to the best Bee.
5. Bee checks local policy and either accepts, denies, or pauses for approval.
6. Bee runs the task through the configured agent runtime or skill.
7. Bee streams progress, tool events, artifacts, and final result back to Hive.
8. Hive exposes the result to the requester and stores audit/log history.
9. If the Bee fails, Hive uses the incident/recovery loop and may reassign the task if policy allows.
