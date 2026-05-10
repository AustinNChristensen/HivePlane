# HivePlane

**HivePlane is the open-source control plane for agent hives.**

HivePlane coordinates worker nodes, local agent runtimes, tools, models, approvals, logs, and fleet operations so teams can run AI agents on their own machines while managing them from a central control plane.

## Why HivePlane?

AI agents are most useful when they can operate close to real data, repos, tools, browsers, calendars, CLIs, local apps, and local models. But that creates a trust and operations problem:

- Where are agents running?
- What tools can they use?
- Who approved sensitive actions?
- Which machines have which models/runtimes?
- How do you install and update worker nodes?
- How do you inspect logs, traces, artifacts, and failures?
- How do worker machines talk to the control plane without public inbound ports?

HivePlane is designed to answer those questions with an open-source, local-first architecture.

## Core Idea

```text
Hive / Control Plane
  ├─ users, orgs, auth, RBAC
  ├─ Bee registry
  ├─ agents, jobs, policies, approvals
  ├─ logs, traces, artifacts, audit
  ├─ Postgres source of truth
  └─ outbound coordinator API
        ▲
        │ secure Bee → Hive connection
        │ recommended self-host transport: Tailscale
        ▼
Bee / Worker Node Daemon
  ├─ installs/configures runtimes
  ├─ runs OpenClaw, Hermes, and local models
  ├─ executes tools under local policy
  ├─ reports health/capabilities/logs
  └─ enforces local safety boundaries
```

The Hive coordinates. Bees execute. Local policy remains the trust boundary.

## Naming

- **HivePlane** — the overall product/project.
- **Hive** — the control plane service/API/dashboard.
- **Bee** — a worker node daemon running on a machine.
- **Swarm** — a group of Bees.
- **HivePlane Cloud** — managed hosted control plane. Coming soon.
- **CLI** — `hive`.

Example CLI shape:

```bash
hive selfhost init
hive network tailscale detect
hive bee token create
hive bee install-command
hive bee status
hive job list
```

## Self-Hosted Networking Model

HivePlane should not require us to host every customer’s control plane or relay all of their Bee traffic.

For self-hosted deployments, the recommended path is:

> Run your own Hive control plane, use Tailscale for private networking, and point each Bee daemon at your Hive URL.

### Recommended: Self-hosted Hive + Tailscale

```text
Hive machine
  https://hive.your-tailnet.ts.net

Bee machines
  connect outbound to:
  wss://hive.your-tailnet.ts.net/hive/bees/connect
```

Benefits:

- no public inbound ports required;
- private-by-default networking;
- works across home, office, cloud, and travel networks;
- MagicDNS-friendly URLs;
- user owns the network path;
- HivePlane avoids becoming the mandatory relay provider.

Two-step Bee setup — install once (no args), then connect:

```bash
# 1. install Bee daemon + `hive` CLI
curl -fsSL https://hive.your-tailnet.ts.net/install/bee.sh | sh

# 2. connect to a Hive
hive login https://hive.your-tailnet.ts.net
hive start
```

Or with a raw Tailnet IP:

```bash
curl -fsSL http://100.87.12.34:8787/install/bee.sh | sh
hive login http://100.87.12.34:8787
hive start
```

Hive install:

```bash
curl -fsSL https://raw.githubusercontent.com/AustinNChristensen/HivePlane/main/infra/install/hive.sh | sh
```

Tailscale is the network layer. HivePlane still handles application-level identity with bootstrap tokens, device keys, RBAC, policies, approvals, and audit logs.

### Supported Deployment Modes

| Mode                   | Description                           | Status      |
| ---------------------- | ------------------------------------- | ----------- |
| Local dev              | Hive and Bee on one machine           | Planned     |
| Self-host + LAN        | Hive URL is a LAN IP/host             | Planned     |
| Self-host + Tailscale  | Recommended self-host mode            | Planned     |
| Self-host + public URL | User-managed domain/reverse proxy/TLS | Planned     |
| HivePlane Cloud        | Managed hosted control plane          | Coming soon |

## HivePlane Cloud

**Coming soon.**

HivePlane Cloud will provide a managed control plane for teams that do not want to self-host Hive themselves.

Planned cloud features:

- managed Hive dashboard/API;
- hosted auth/org/RBAC;
- managed audit/log retention;
- fleet observability;
- policy and approval workflows;
- hosted relay/networking options where needed;
- enterprise SSO and compliance features;
- priority support.

The open-source core should remain genuinely useful without HivePlane Cloud.

## MVP Pillars

1. **Bee daemon** — phones home, receives jobs, enforces local policy, streams logs.
2. **Self-hosted Hive** — control plane API/dashboard backed by Postgres.
3. **Tailscale-first self-host networking** — private Bee-to-Hive connectivity without us hosting traffic.
4. **Remote provisioning** — bootstrap fresh machines, install runtimes, configure models, and register Bees.
5. **Agent/runtime adapters** — OpenClaw, Hermes, Ollama, MLX, and future runtimes.
6. **Security model** — device identity, RBAC, approvals, local policy enforcement, secret redaction.
7. **Open-source core** — useful self-hosted/local product with optional managed enterprise cloud later.

## License

HivePlane is licensed under the Apache License 2.0.

## Status

Early foundation work. APIs, architecture, and implementation details are actively being designed.
