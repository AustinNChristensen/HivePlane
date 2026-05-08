# Worker Node Daemon

The worker node daemon is the core primitive in HivePlane.

Infrastructure providers such as SSH, Docker, Proxmox, cloud VPSs, or GPU hosts are optional ways to create machines. The daemon is what makes a machine manageable by HivePlane.

## Responsibilities

The daemon must:

1. Phone home to the hosted or self-hosted control plane.
2. Authenticate as a device using a locally generated keypair.
3. Receive install/configuration jobs.
4. Execute safe local commands.
5. Install OpenClaw, Hermes, and other agent runtimes.
6. Install local model backends such as Ollama and MLX.
7. Configure networking, including optional Tailscale/mesh setup.
8. Register the node as an agent/gateway with a host gateway.
9. Configure model providers/models inside OpenClaw/Hermes.
10. Report status, logs, capabilities, and health.
11. Enforce local permissions.

## Process Model

```text
worker node daemon
  ├─ connection manager
  │   ├─ outbound websocket
  │   └─ retry/backoff/offline queue
  ├─ identity manager
  │   ├─ local keypair
  │   └─ token refresh/challenge signing
  ├─ job runner
  │   ├─ job lifecycle
  │   ├─ step execution
  │   ├─ cancellation
  │   └─ idempotency
  ├─ recipe engine
  ├─ service manager
  ├─ runtime adapters
  ├─ model backend adapters
  ├─ policy engine
  └─ health reporter
```

## Terminology

Use:

- worker node;
- edge node;
- agent node;
- control plane;
- coordinator.

Avoid “slave.”

## Build Phases

### Phase 1 — Skeleton

- daemon binary/package;
- config file;
- outbound WebSocket;
- heartbeat;
- registration;
- command execution with logs.

### Phase 2 — Bootstrap Install

- bootstrap token;
- install script endpoint;
- macOS launchd support;
- Linux systemd support;
- first healthcheck.

### Phase 3 — Job Runner and Recipes

- job queue;
- recipe schema;
- event stream;
- step logs;
- idempotency;
- OpenClaw/Hermes/Ollama recipes.

### Phase 4 — Runtime Configuration

- OpenClaw adapter;
- Hermes adapter;
- Ollama adapter;
- MLX adapter;
- model configuration;
- runtime healthchecks.

### Phase 5 — Gateway Integration

- pair node with host gateway;
- expose capabilities;
- route runs to worker node;
- show node as agent/gateway in dashboard.
