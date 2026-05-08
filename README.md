# HivePlane

**HivePlane is the open-source control plane for agent hives.**

It coordinates worker nodes, local agent runtimes, tools, models, approvals, logs, and fleet operations so teams can run AI agents on their own machines while managing them from a central control plane.

## Why HivePlane?

AI agents are most useful when they can operate close to real data, repos, tools, browsers, calendars, CLIs, and local services. But that creates a trust and operations problem:

- Where are agents running?
- What tools can they use?
- Who approved sensitive actions?
- Which machines have which models/runtimes?
- How do you install and update worker nodes?
- How do you inspect logs, traces, artifacts, and failures?

HivePlane is designed to answer those questions with an open-source local-first architecture.

## Core Idea

```text
Hosted or self-hosted control plane
  ├─ users, orgs, auth, RBAC
  ├─ node registry
  ├─ agents and policies
  ├─ jobs, schedules, approvals
  ├─ logs, traces, artifacts, audit
  └─ outbound coordinator
        ▲
        │ secure outbound connection
        ▼
Worker node daemon
  ├─ installs/configures runtimes
  ├─ runs OpenClaw, Hermes, and local models
  ├─ executes tools under local policy
  ├─ reports health/capabilities/logs
  └─ enforces local safety boundaries
```

The cloud coordinates. Worker nodes execute. Local policy remains the trust boundary.

## MVP Pillars

1. **Worker node daemon** — phones home, receives jobs, enforces local policy, streams logs.
2. **Remote provisioning** — bootstrap fresh machines, install runtimes, configure models, and register nodes.
3. **Agent/runtime adapters** — OpenClaw, Hermes, Ollama, MLX, and future runtimes.
4. **Control plane** — dashboard/API for orgs, nodes, agents, jobs, approvals, logs, and audit.
5. **Security model** — device identity, RBAC, approvals, local policy enforcement, secret redaction.
6. **Open-source core** — useful self-hosted/local product with optional managed enterprise cloud later.

## License

HivePlane is licensed under the Apache License 2.0.

## Status

Early foundation work. APIs, architecture, and implementation details are actively being designed.
