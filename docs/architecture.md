# Architecture

HivePlane has two primary sides:

1. **Control plane** — web/API service that manages users, orgs, nodes, agents, jobs, policies, approvals, logs, and audit history.
2. **Worker node daemon** — local process installed on machines that executes jobs, installs/configures runtimes, manages models, and enforces local policy.

## High-Level Diagram

```text
┌─────────────────────────────────────────────────────────────┐
│                    HivePlane Control Plane                  │
│  Dashboard, API, auth, orgs, nodes, jobs, logs, approvals    │
└───────────────▲───────────────────────────────┬─────────────┘
                │ outbound WebSocket/HTTPS      │ REST/API
                │                               │
┌───────────────┴───────────────────────────────▼─────────────┐
│                       Worker Node Daemon                    │
│ device identity, job runner, recipes, runtime adapters,      │
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

## Key Components

| Component        | Responsibility                                             |
| ---------------- | ---------------------------------------------------------- |
| Web dashboard    | Manage nodes, agents, jobs, approvals, logs, and settings  |
| API service      | CRUD APIs, auth checks, job queue, event ingestion         |
| Coordinator      | Maintains outbound node connections and dispatches jobs    |
| Worker daemon    | Executes node jobs and streams events                      |
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
