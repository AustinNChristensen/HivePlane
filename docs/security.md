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
