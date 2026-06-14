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
- **CLI** — `hive` for control-plane operations on a Hive machine; `bee` for worker-daemon operations on a Bee machine.

Example CLI shape:

```bash
hive init             # generate hive-config.json + admin token
hive up               # init + install service unit + start
hive status           # /version health probe + log paths
bee login             # pair a Bee with a Hive
bee start             # start the worker daemon as a service
bee status            # config + identity + session + service state
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

Tailscale is the network layer. HivePlane still handles application-level identity with bootstrap tokens, device keys, RBAC, policies, approvals, and audit logs.

## Install Guide

End-to-end walkthrough: stand up a Hive on one machine, install a Bee daemon on another, connect them, and dispatch a test job.

### Prerequisites

On both the Hive machine and each Bee machine:

- **Node 20+** (`node -v`).
- **git** on PATH.
- **A reachable network path** from each Bee to the Hive's URL. The recommended setup is [Tailscale](https://tailscale.com) on every machine — gives you stable `*.ts.net` hostnames and encryption at the network layer with no public ports. LAN works too. If you expose the Hive on the public internet, use native TLS (`HIVEPLANE_TLS_CERT` + `HIVEPLANE_TLS_KEY`) or terminate TLS at a reverse proxy.

Everything else (pnpm, the daemon binary, identity keypair, service unit) is set up by the install scripts.

### Step 1 — Install and start the Hive

On the control-plane machine:

```bash
# install + start as a service (default). Survives reboots, runs under
# launchd (macOS) / systemd-user (Linux), generates an admin token for you.
curl -fsSL https://raw.githubusercontent.com/AustinNChristensen/HivePlane/main/infra/install/hive.sh | sh
```

This:

- clones HivePlane to `~/.hiveplane/install` and runs `pnpm install`;
- drops the `hive` shim into `~/.local/bin`;
- writes `~/.hiveplane/hive-config.json` (mode 0600) with a freshly-generated `adminToken` and the bind host/port (default `0.0.0.0:4483`);
- installs a launchd plist (`~/Library/LaunchAgents/com.hiveplane.hive.plist`) on macOS or a systemd user unit (`~/.config/systemd/user/hiveplane-hive.service`) on Linux;
- starts the service. The Hive will come back automatically after reboots and crashes.

Optional incident alerts can be configured in `hive-config.json` with
`incidentNotificationWebhookUrl` or `incidentNotificationCommand`. The Hive sends
deduped `needs_approval` / `unresolved` incident notifications and records
whether delivery was sent or failed.

For a local OpenClaw/iMessage sink on the Hive machine:

```json
{
  "incidentNotificationCommand": [
    "/Users/you/.hiveplane/install/infra/install/incident-notify-imessage.js",
    "--target",
    "+15555550123"
  ]
}
```

The command reads the notification JSON on stdin and sends a concise iMessage
through `openclaw message send`. Set `OPENCLAW_BIN` if the OpenClaw CLI is not
at `/opt/homebrew/bin/openclaw`.

`hive.sh` prints the admin token at the end of the run — save it. You can re-read or rotate it anytime with `hive init` (and `--rotate-admin-token` to mint a fresh one). Manage the service with:

```bash
hive status     # installed/running, log paths, bind, /version health probe
hive logs -f    # tail the daemon's stdout
hive stop       # stop without uninstalling
hive restart
hive uninstall  # remove the launchd/systemd unit
```

For development you can skip the service install entirely:

```bash
curl -fsSL .../hive.sh | sh -s -- --foreground   # Ctrl-C to stop
```

> **Linux only**: run `loginctl enable-linger $USER` once if you want the Hive to keep running when you log out.

The Hive snapshots its state (registered Bees, signed-heartbeat sessions, bootstrap tokens, jobs) to `~/.hiveplane/hive-state.json` (mode 0600) on every mutation. Restarting the Hive reloads the snapshot, so paired Bees stay paired across reboots and crashes. Pass `--no-persist` (or set `HIVEPLANE_PERSIST=false`) to run ephemerally — useful for tests and CI. Use `--state-file <path>` / `HIVEPLANE_STATE_FILE` to override the location.

Find the Hive URL each Bee will use:

```bash
tailscale status                # gives you e.g. mac-mini.tailnet-name.ts.net
# or `ip a` / `hostname -I` for LAN setups
```

Quick sanity check from another machine on the same network:

```bash
curl http://mac-mini.tailnet-name.ts.net:4483/healthz
# {"ok":true,"service":"hiveplane-hive"}
```

In `--foreground` mode the Hive prints the dashboard URL and auto-opens it in your default browser on a TTY; pass `--no-open` (or set `HIVEPLANE_OPEN_BROWSER=false`) to skip on a headless server. Under the launchd/systemd unit there's no TTY, so the dashboard doesn't auto-open — visit `http://<hive>:4483/dashboard` manually. The **dashboard** shows connected Bees, jobs, the current pairing key, and a bootstrap-token minter — paste your admin token (from `hive-config.json` or `hive init`) into the field at the top to unlock the admin features; the Bees list works without auth. `/` serves the public landing page, while `/dashboard` and `/index.html` serve the operator app. `curl http://mac-mini.tailnet-name.ts.net:4483/version` confirms which build the Hive is running — useful if the dashboard 404s, since that usually means the Hive process is older than the source on disk and needs a restart.

### Step 2 — Read the pairing key off the dashboard

After saving your admin token in the top-right field, the **Pair a new Bee** card appears at the top of the **Bees** tab with the current pairing key — an 8-character code like `K7RQ-2P9X`. Keys are single-use, default-15-minute TTL, and rotate automatically after each successful pair (or any time you click _Rotate_).

For the fastest path, click **Copy Install** and run the copied command on the Bee machine. It installs HivePlane, pairs with this Hive, and starts the Bee service in one pass.

For unattended/scripted Bee installs, mint a long-form bootstrap token instead via the dashboard's **Tokens** tab, or:

```bash
TOKEN=$(curl -fsSL -X POST http://mac-mini.tailnet-name.ts.net:4483/api/bootstrap-tokens \
  -H "Authorization: Bearer $HIVEPLANE_ADMIN_TOKEN" \
  -H "content-type: application/json" \
  -d '{"beeName":"laptop-1"}' | jq -r .token)
echo $TOKEN
# hp_boot_xxxxxxxxxxxxxxxxxxx
```

Bootstrap tokens are single-use and expire in 30 minutes by default.

### Step 3 — Install the Bee daemon

On each Bee machine, either run the one-command install copied from the dashboard, or use the manual flow:

```bash
curl -fsSL http://mac-mini.tailnet-name.ts.net:4483/install/bee.sh | sh
```

This clones HivePlane to `~/.hiveplane/install`, runs `pnpm install`, drops `bee` and `hiveplane-bee` shims into `~/.local/bin`, and generates a persistent Ed25519 identity under `~/.hiveplane`. It does **not** start anything yet.

If `~/.local/bin` isn't on your shell's PATH, the installer prints the line you need to add to your shell rc.

You can also provision a reachable machine over SSH from the Hive box:

```bash
hive node provision ssh user@host \
  --hive-url http://mac-mini.tailnet-name.ts.net:4483 \
  --profile macos-openclaw \
  --name laptop-1
```

The SSH provisioner runs a harmless remote shell healthcheck first, mints a single-use bootstrap token from the local Hive admin config, streams the remote install logs, applies the selected Bee policy profile, and starts the Bee service. It does not store SSH passwords, private keys, or cloud-side SSH credentials. Use `--healthcheck-only` to test access before provisioning, and `--dry-run` to inspect the planned install URL/profile without minting a token.

### Step 4 — Connect the Bee to the Hive

Still on the Bee machine, run `bee login` with no arguments — it'll prompt you for the Hive URL and the pairing key from Step 2:

```text
$ bee login
Hive URL: http://mac-mini.tailnet-name.ts.net:4483
Pairing key (or bootstrap token, blank to skip): K7RQ-2P9X
Bee name [laptop-1]:
Logged into http://mac-mini.tailnet-name.ts.net:4483/
Bee identity: sha256:...
Registered with Hive as bee_xxxxxxxx (signed-heartbeat mode).
Run `bee start` to begin heartbeating.
```

For scripted/unattended installs you can pass everything on the command line:

```bash
# pairing key (short form, from the dashboard):
bee login http://mac-mini.tailnet-name.ts.net:4483 \
  --name laptop-1 \
  --pairing-key K7RQ-2P9X

# or bootstrap token (long form):
bee login http://mac-mini.tailnet-name.ts.net:4483 \
  --name laptop-1 \
  --token hp_boot_xxxxxxxxxxxxxxxxxxx
```

Either path:

- writes the Hive URL to `~/.hiveplane/config.json`
- performs the registration handshake with the Hive (consumes the credential, gets back a session token + `beeId`)
- saves the session to `~/.hiveplane/session.json` for signed heartbeats

### Step 5 — Start the Bee

```bash
bee start
```

On macOS this writes `~/Library/LaunchAgents/com.hiveplane.bee.plist` and bootstraps it via `launchctl`. On Linux it writes `~/.config/systemd/user/hiveplane-bee.service` and runs `systemctl --user enable --now`. Either way, the daemon now survives reboots and crashes. Logs land in `~/.hiveplane/logs/` on macOS, and on Linux are read from the journal via `bee logs -f` — minimal Linux environments without `journalctl` (containers, WSL1) fall through to the same `~/.hiveplane/logs/` files automatically.

> **Linux only**: run `loginctl enable-linger $USER` once if you want the daemon to keep running when you log out.

### Step 6 — Verify the Bee is connected

Open the dashboard's **Bees** tab in a browser — your new Bee should appear with status `online` and a heartbeat count that ticks up every 10 seconds. Or via curl from any machine that can reach the Hive:

```bash
curl http://mac-mini.tailnet-name.ts.net:4483/api/bees | jq
```

On the Bee itself, `bee status` shows the same info plus session details and service state.

Repeat steps 3–5 for each additional Bee — the pairing-key card on the dashboard rotates automatically after every successful pair, so the next code is always already there. (Click _Rotate_ to invalidate the current key on demand.)

### Step 7 — Dispatch a test job

The point of all this. From the Hive (or anywhere with the admin token), enqueue a healthcheck for a specific Bee:

```bash
BEE_ID=bee_xxxxxxxx_xxxxxxxxxxxx        # from `curl /api/bees`
curl -fsSL -X POST http://mac-mini.tailnet-name.ts.net:4483/api/bees/$BEE_ID/jobs \
  -H "Authorization: Bearer $HIVEPLANE_ADMIN_TOKEN" \
  -H "content-type: application/json" \
  -d '{"type":"run_healthcheck","payload":{}}'
```

The Bee picks it up on the next heartbeat (≤10s), runs it, and posts a completion. Watch the **Jobs** tab in the dashboard — the row's status pill flips from `queued` → `assigned` → `succeeded` and the _Detail_ column shows the output. Or via curl:

```bash
curl http://mac-mini.tailnet-name.ts.net:4483/api/jobs?beeId=$BEE_ID \
  -H "Authorization: Bearer $HIVEPLANE_ADMIN_TOKEN" | jq
```

Status should be `succeeded` with `output.daemonVersion` and `output.beeId`.

### Step 8 — (Optional) Allow `run_command` jobs

For the Hive to dispatch arbitrary shell commands to a Bee, the **Bee operator** has to opt in via a local policy. By default, only safe read-only commands are allowed.

Start from a permission profile:

```bash
bee policy profiles
bee policy profile dev_box
```

Profiles cover common Bee roles such as `personal_assistant`, `browser_worker`, `finance_safe`, `server_worker`, `read_only_observer`, and `dev_box`. They set allowed job types, commands that need approval, and obvious denylists.

Custom overrides are still local and explicit. Use the CLI for one-off command allowlist changes:

```bash
bee policy allow git
```

Or edit `~/.hiveplane/policy.json` directly:

```json
{
  "runCommand": {
    "allow": ["git", "ls", "ps", "df", "uptime"]
  }
}
```

The allowlist matches on `argv[0]` basename. Restart isn't required — the daemon reads policy at job execution time.

Then from the Hive:

```bash
curl -fsSL -X POST http://mac-mini.tailnet-name.ts.net:4483/api/bees/$BEE_ID/jobs \
  -H "Authorization: Bearer $HIVEPLANE_ADMIN_TOKEN" \
  -d '{"type":"run_command","payload":{"command":"git","args":["status"]}}'
```

Inspect the result the same way as Step 7. Failed `run_command` jobs include the policy reason in their `error` payload, so an AI consuming the API can tell the difference between "command failed" and "command refused locally."

### Day-2 commands on the Bee

```bash
bee status                # config + identity + session + service state
bee logs -f               # follow daemon output
bee stop / bee restart    # control the running service
bee logout                # forget Hive URL + session, stop the service
bee disable               # remove the service unit (use `bee start` to reinstall)
```

### Day-2 commands on the Hive

```bash
hive status               # config + service state + /version health probe
hive logs -f              # tail the Hive service
hive stop / hive restart  # control the running service
hive init --rotate-admin-token   # mint a fresh admin bearer token
hive uninstall            # remove the service unit (use `hive up` to reinstall)
```

### Known limitations to track

- **[#49](https://github.com/AustinNChristensen/HivePlane/issues/49)** — No TLS on the Hive; rely on Tailscale or a reverse proxy.
- **[#50](https://github.com/AustinNChristensen/HivePlane/issues/50)** — `run_command` policy DX is hand-edited JSON.
- **[#51](https://github.com/AustinNChristensen/HivePlane/issues/51)** — systemd path is unverified on real Linux.

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

Cloud is an operating convenience, not a replacement for self-hosting. The
default self-host path stays Hive + Tailscale, with Bees connecting outbound to
the user-owned Hive URL.

## Design Docs

- [Architecture](docs/architecture.md)
- [Vision](docs/vision.md)
- [MVP demo script](docs/mvp-demo-script.md)
- [Infrastructure providers](docs/infrastructure-providers.md)
- [Systems and scoped permissions](docs/systems-permissions.md)
- [Sub-agent provisioning](docs/sub-agent-provisioning.md)
- [Self-healing recovery](docs/self-healing-todo.md)
- [Competitor analysis](docs/competitor-analysis.md)

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

The Apache-2.0 core should include the parts users must be able to inspect,
self-host, and trust: Hive, Bee, pairing/session identity, local policy, job and
task execution, recovery, dashboard operations, core runtime/model adapters,
and docs.

Managed enterprise features may live in HivePlane Cloud or paid extensions when
they primarily reduce operational burden for teams: hosted control plane,
enterprise SSO/RBAC, long-retention audit logs, compliance reporting, managed
relay/networking, shared policy packs, and priority support.

Contributions should preserve that split. Reliability, safety, interoperability,
and self-hosting improvements belong in the open-source core by default.

## Status

Early foundation work. APIs, architecture, and implementation details are actively being designed.
