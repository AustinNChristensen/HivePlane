# Infrastructure Providers

HivePlane's core daemon should not depend on one infrastructure substrate. A provider creates or finds a machine, then hands it to the normal Bee bootstrap flow.

## Provider Interface

A provider should support:

```ts
type Provider = {
  kind: "local" | "ssh" | "docker" | "proxmox" | "vps" | string;
  listNodes(): Promise<ProviderNode[]>;
  createNode(request: CreateNodeRequest): Promise<ProviderNode>;
  destroyNode(nodeId: string): Promise<void>;
  getBootstrapTarget(nodeId: string): Promise<BootstrapTarget>;
};
```

`BootstrapTarget` should include:

- reachable host or connection method;
- OS/architecture;
- supported service manager, if known;
- install command transport, such as local shell, SSH, cloud-init, or console script;
- metadata labels to attach to the Bee after registration.

## Core Rule

Provider code may create or reach a machine, but the Bee install flow remains the source of truth:

1. Hive creates a pairing key or bootstrap token.
2. Provider gets a shell/bootstrapping path onto the target.
3. Provider runs the normal `bee.sh` one-command install with the Hive URL and token/key.
4. Bee registers, starts heartbeat, and reports capabilities.
5. Hive routes work based on Bee state, not provider state.

## Provider Types

### Local Machine

Used for dogfood and first-run setup. The operator runs `hive.sh` and `bee.sh` directly.

### SSH

Good first remote provider. Hive can run the one-command installer over SSH on a known host, then rely on normal Bee registration and heartbeats.

### Docker

Useful for CI/demo environments and ephemeral test Bees. Docker should stay optional because many target workflows need real host apps, files, keychains, and local models.

### Proxmox

Optional homelab/server substrate. A Proxmox provider can clone a VM/template, inject cloud-init or SSH keys, then run the Bee bootstrap command.

Proxmox should not be a core requirement. It is one provider behind the same bootstrap contract.

### VPS / Cloud VM

Future providers can create a VM through a cloud API, run cloud-init with the Bee install command, and then let HivePlane manage it as a normal Bee.

## Non-Goals For The Core

- Replacing Terraform/Pulumi.
- Becoming a generic VM lifecycle manager.
- Requiring Proxmox, Docker, or any cloud provider.
- Treating provider inventory as more authoritative than Bee heartbeat/session state.

## Acceptance Signal

A provider is useful when it can create or reach a machine, run the normal Bee install command, and leave HivePlane with a healthy registered Bee. Everything after that should be provider-agnostic.
