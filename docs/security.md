# Security Model

HivePlane manages machines that may have access to private repos, credentials, browsers, files, and local networks. The security model must be explicit from day one.

## Core Principle

The cloud coordinates. The node enforces.

The control plane can request work, but the worker node daemon must enforce local policy before running commands, changing configuration, installing software, or exposing secrets.

## Key Threats

1. Prompt injection causes destructive tool calls.
2. Hosted control plane is compromised or misconfigured.
3. Stolen daemon token impersonates a node.
4. Unauthorized user approves dangerous action.
5. Secrets leak into logs or model context.
6. Installer recipes execute unexpected commands.
7. Artifacts expose private files.

## MVP Mitigations

| Threat            | Mitigation                                   |
| ----------------- | -------------------------------------------- |
| Dangerous actions | Local policy + approvals                     |
| Cloud compromise  | Device-side enforcement                      |
| Token theft       | Short-lived tokens + local keypair challenge |
| Bad approvals     | RBAC + audit logs                            |
| Secret leakage    | Secret redaction + local secret injection    |
| Recipe abuse      | Signed/checksummed recipes + visible logs    |
| Artifact leakage  | Explicit artifact upload rules               |

## Transport Security

HTTP is acceptable only when Bee-to-Hive traffic stays on an encrypted Tailnet such as Tailscale or on a trusted LAN. Do not expose a plain HTTP Hive to the public internet: bootstrap tokens, session tokens, job payloads, and logs can all contain sensitive data.

Native TLS is enabled by passing certificate and key paths to the Hive runtime:

```bash
HIVEPLANE_TLS_CERT=/etc/letsencrypt/live/hive.example.com/fullchain.pem \
HIVEPLANE_TLS_KEY=/etc/letsencrypt/live/hive.example.com/privkey.pem \
HIVEPLANE_HIVE_HOST=0.0.0.0 \
HIVEPLANE_HIVE_PORT=4483 \
pnpm --filter @hiveplane/web start -- --no-open
```

For production self-hosting, a reverse proxy is also fine. Bind the Hive to loopback and terminate TLS in front:

```caddyfile
hive.example.com {
  reverse_proxy 127.0.0.1:4483
}
```

When running behind a proxy, set the Hive bind host to `127.0.0.1` and give Bees the public `https://hive.example.com` URL.

## Device Identity

Each worker node generates a keypair locally during registration. The private key never leaves the node.

The control plane stores the public key and uses it to verify node identity and token refresh challenges.

## Approval Rules

Sensitive actions should pause for approval by default:

- installing software;
- modifying system services;
- changing networking;
- editing OpenClaw/Hermes config;
- external writes such as creating PRs;
- destructive shell commands;
- exposing secrets to tools.

## Bee Permission Profiles

Bee operators can apply common local policy presets with `bee policy profile <id>` and still edit `~/.hiveplane/policy.json` afterward. The dashboard also stores the selected profile on the Bee profile so operators can see the intended risk level without reading raw policy JSON.

| Profile              | Risk   | Intended use                                         |
| -------------------- | ------ | ---------------------------------------------------- |
| `read_only_observer` | Low    | Health, inventory, and safe read-only status checks. |
| `finance_safe`       | Low    | Finance-connected machines with writes gated.        |
| `personal_assistant` | Medium | Default user machine assistant with approvals.       |
| `browser_worker`     | Medium | Browser/app workflows with external writes gated.    |
| `server_worker`      | Medium | Always-on infrastructure and recovery jobs.          |
| `dev_box`            | High   | Trusted developer workstations running repo tools.   |

## Audit Logs

HivePlane should record append-only audit events for:

- user logins;
- device registration/revocation;
- policy changes;
- node jobs;
- approval decisions;
- runtime configuration changes;
- secret reference changes;
- external writes.
