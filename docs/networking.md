# Networking Model

HivePlane supports hosted and self-hosted control planes. For self-hosted deployments, the recommended networking model is **Tailscale-first**.

## Principle

HivePlane should not require the project maintainers to host every control plane or relay every Bee connection.

Users should be able to run their own Hive control plane and privately connect Bees to it over their own network.

## Recommended Self-Hosted Flow

1. User installs Hive on a machine/server.
2. User installs Tailscale on the Hive machine.
3. Hive detects or asks for the reachable Hive URL.
4. Hive creates a short-lived Bee bootstrap token.
5. Hive shows a Bee install command.
6. User runs the command on a Bee machine that is also on the Tailnet.
7. Bee connects outbound to Hive.
8. Hive marks Bee online and begins assigning jobs.

Example Hive URL:

```text
https://hive.your-tailnet.ts.net
```

Example Bee WebSocket endpoint:

```text
wss://hive.your-tailnet.ts.net/hive/bees/connect
```

Example install command:

```bash
curl -fsSL https://hive.your-tailnet.ts.net/install/bee.sh | sh -s -- \
  --hive-url https://hive.your-tailnet.ts.net \
  --token hp_boot_...
```

## Supported Modes

### 1. Local Development

Hive and Bee run on one machine.

```text
http://localhost:4483
```

### 2. LAN

Hive is reachable on a private LAN address.

```text
http://192.168.1.50:4483
```

This is useful but less robust than Tailscale because IPs and firewalls can change.

### 3. Self-Hosted + Tailscale

Recommended for most self-hosted users.

```text
https://hive.your-tailnet.ts.net
```

Benefits:

- private networking;
- no public port forwarding;
- works across networks;
- friendly DNS;
- user-owned network path.

### 4. Self-Hosted + Public URL

Advanced users can expose Hive behind their own domain, reverse proxy, and TLS.

```text
https://hive.example.com
```

### 5. HivePlane Cloud

Managed hosted control plane. Coming soon.

## Security Boundary

Tailscale is a transport/network layer. It is not the entire security model.

HivePlane still needs:

- bootstrap tokens;
- Bee device keypairs;
- signed device authentication;
- RBAC;
- policy enforcement;
- approvals;
- audit logs;
- secret redaction.

A Bee should not trust a Hive only because it is reachable over a Tailnet. It should authenticate the Hive and its assigned jobs at the application layer too.

## CLI Shape

Possible commands:

```bash
hive init
hive network tailscale detect
hive network tailscale recommend-url
hive bee token create
hive bee install-command
```

Bee install:

```bash
hive bee install \
  --hive-url https://hive.your-tailnet.ts.net \
  --token hp_boot_...
```
