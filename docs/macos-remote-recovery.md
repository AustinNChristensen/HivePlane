# Remote macOS recovery contract

A remote Mac should be supportable without direct machine access when the Mac is powered on, online, and reachable through at least one approved management path. HivePlane cannot repair physical power, broken internet, or a completely dead Tailscale path by itself, but any reachable app, service, permission, or account issue should have a prepared recovery path.

## Non-negotiable install checklist

Complete this before remote Mac leaves the setup bench:

- Tailscale SSH enabled for the remote Mac and verified from operator devices.
- A local admin account exists for break-glass support.
- FileVault recovery path is documented outside the machine.
- OpenClaw, HivePlane Bee daemon, imsg, Messages.app, and model runtime services are installed under launchd or another restartable supervisor.
- The terminal/service runtime has Full Disk Access.
- The terminal/service runtime has Automation permission to control Messages.app.
- Messages.app is signed in, can send a test iMessage, and does not require immediate 2FA.
- Screen Sharing or another approved remote GUI path is enabled for macOS prompts that cannot be solved from shell.
- HivePlane incident logging is enabled at `~/.hiveplane/incidents.jsonl`.
- Remote command allowlists include only known repair binaries or purpose-built repair scripts.

## Installer path

Use the generic Bee installer for the HivePlane-specific setup. Manual copying/editing is only the fallback.

```bash
curl -fsSL https://raw.githubusercontent.com/AustinNChristensen/HivePlane/main/infra/install/bee.sh | sh -s -- \
  --hive-url https://hive.example.com \
  --token "$HIVEPLANE_BOOTSTRAP_TOKEN" \
  --name macos-bee \
  --method auto
```

The installer:

- clones HivePlane into `~/.hiveplane/install`;
- installs the `bee`, `hiveplane-bee`, and `hiveplane-rescue` shims;
- creates or reuses the local Bee identity;
- pairs with Hive using a pairing key or bootstrap token;
- prompts for Hive URL, credential, Bee name, and start method when run interactively;
- starts the Bee as a launchd service on macOS when `--method auto` or `--method service` is used.

Default install path is `~/.hiveplane/install`, so the first pass does not require `sudo` or `/opt` writes. Use `HIVEPLANE_INSTALL_DIR` or `--install-dir` only when you intentionally want another install path.

After the Bee is installed, copy any machine-specific recovery scripts from `examples/macos-repairs/` into a stable local path, then allowlist only the exact repair commands through Bee policy. Do not allowlist a shell on production Macs just to run these scripts.

## Reachable-failure classes we must handle

These should be recoverable remotely:

- OpenClaw gateway or worker stuck, crashed, or misconfigured.
- imsg send/receive failure while Messages.app remains signed in.
- Messages.app hung or not running.
- launchd service unloaded or unhealthy.
- Ollama/model runtime stopped, unhealthy, or missing expected models.
- Disk pressure, runaway logs, or obvious cache bloat.
- Stale local config, expired service token, or broken repo state.
- macOS privacy grant was already approved but the app needs a restart.
- iMessage account needs manual GUI interaction and a remote screen path is still available.

These are out of HivePlane scope unless there is a second independent access path:

- Mac is powered off.
- Mac is asleep and cannot be woken.
- No internet/LAN path exists.
- Tailscale is down and no fallback tunnel or local-link Hive URL exists.
- macOS asks for Apple ID 2FA and nobody can complete it.
- Full Disk Access or Automation was never granted during setup.
- Disk, OS, or hardware failure prevents normal login.

## Required recovery lanes

Use three lanes, in this order.

1. Local self-heal: the Bee detects a failing check and runs a locally allowlisted remediation recipe.
2. Remote shell: Hive enqueues an allowlisted command or purpose-built repair script over the Bee job channel. The remote Mac pulls this work on its next outbound heartbeat; Hive does not need inbound access to the remote Mac.
3. Remote GUI: Screen Sharing handles macOS/iMessage prompts that cannot be safely automated from shell.

If all three lanes are unavailable, the incident should be reported as requiring physical or account-owner intervention rather than pretending HivePlane can repair it.

## Tailscale account strategy

A remote Mac may live in a different tailnet while operator machines live in the operator tailnet. Do not make daily support depend on manually switching tailnets unless there is no better option.

Preferred setup:

- Keep the remote Mac enrolled in its owner tailnet.
- Share the remote Mac to the operator through Tailscale machine sharing.
- Restrict access with Tailscale ACLs to only the management ports needed for support, such as SSH, HivePlane, and remote GUI if used.
- Use the remote Mac's fully qualified MagicDNS name when accessing it from the operator tailnet.

Important limitation: shared machines are designed for inbound access from the recipient tailnet. If remote Mac needs to initiate connections back into the operator tailnet, such as a Bee heartbeating to a Hive hosted only on the operator tailnet, do not rely on shared-machine inbound access alone.

Preferred heartbeat/job path:

- Put the Hive endpoint behind public HTTPS with auth.
- Install/pair the remote Mac with a dashboard pairing key or single-use bootstrap token.
- Keep the Hive admin token only with operators; Bees persist their own signed heartbeat session after pairing.
- Queue repairs from the Hive/dashboard/API; the remote Mac receives them in the heartbeat response and posts results back with its signed Bee session.
- Do not advertise operator tailnet routes to the remote Mac for this path.

This gives HivePlane two-way data movement without exposing the operator's whole tailnet:

- Remote Mac -> Hive: signed heartbeat, health checks, incidents, and job results.
- Hive -> remote Mac: queued jobs returned inside the heartbeat response.

Other acceptable patterns:

- Run a Hive/relay endpoint inside the owner tailnet.
- Use a dedicated management node that has the correct tailnet membership and exposes only the needed HivePlane route.

Fallback options:

- Fast user switching in the Tailscale client is acceptable for occasional manual admin, but it is not the primary support model because only one tailnet is active for normal traffic at a time.
- Running multiple Tailscale daemons or a userspace/SOCKS second instance is a lab workaround, not the default remote Mac setup.
- Inviting operators as users in the owner tailnet can work if the owner is comfortable with it, but machine sharing is cleaner when the support surface is one managed Mac.

## Remote macOS baseline health checks

The remote macOS Bee should report at least:

- `openclaw-gateway`: `openclaw gateway status`
- `openclaw-channel-imessage`: OpenClaw/iMessage channel probe
- `imsg-cli`: `imsg` health or a bounded send-capability probe
- `messages-app`: Messages.app process/running state
- `hiveplane-bee-launchd`: launchd service state
- `tailscale-network`: `tailscale status`
- `ollama-service`: model runtime process/API state
- `ollama-models`: required model presence
- `disk-pressure`: root volume free space

For checks that cannot safely send a real message, prefer a read-only probe first. Use test sends only against an explicit test handle.

Use `docs/macos-agent-supervisor.example.json` as the starting recovery profile. Before handoff, replace machine-specific values such as the launchd domain/user id, repair script path, and required Ollama models.

## Repair scripts to ship

Prefer small scripts under a stable local repairs directory, such as `~/.hiveplane/repairs/` or `/opt/hiveplane/repairs/`, instead of broad shell allowlists:

- `restart-openclaw`: restart OpenClaw gateway/workers and print status.
- `restart-imessage-stack`: quit/reopen Messages.app, restart imsg-dependent services, then run the iMessage probe.
- `repair-imsg-permissions-check`: verify Full Disk Access / Automation symptoms and return a clear "needs GUI" result if permissions are missing.
- `restart-hiveplane-bee`: reload the Bee launchd service.
- `restart-ollama`: restart Ollama and verify required models.
- `collect-openclaw-logs`: collect bounded OpenClaw, imsg, launchd, and HivePlane logs.
- `cleanup-disk-pressure`: remove only known disposable caches/logs and report before/after disk usage.
- `git-pull-known-good`: pull a known branch in a known repo path, then run the service restart recipe.

The Bee policy allowlist should point at those scripts directly. Avoid `/bin/sh` and arbitrary command execution on production remote Mac.

The example scripts live in `examples/macos-repairs/`. They are intentionally small, bounded, and suitable for direct path allowlisting.

## Acceptance test before handoff

Before handoff:

1. From a different machine, prove Tailscale SSH works.
2. Prove remote Mac can pair and heartbeat to the HTTPS Hive endpoint with a valid pairing key/bootstrap token.
3. Prove operator can queue a `run_command` job with the Hive admin token and cannot use admin APIs without it.
4. From HivePlane, prove a `run_command` job can execute an allowlisted harmless command.
5. Kill OpenClaw and confirm HivePlane marks remote Mac degraded, runs `restart-openclaw`, and records an incident.
6. Quit Messages.app and confirm `restart-imessage-stack` restores the probe.
7. Stop Ollama and confirm `restart-ollama` restores the model check.
8. Force a non-repairable permission/account condition and confirm the incident says `needs GUI` or `needs account owner`, not a fake green state.
9. Use remote screen sharing once end-to-end to prove macOS prompts are reachable.

## Operating rule

HivePlane's promise for a remote Mac is not "never fails." The promise is:

> If the Mac is reachable, we can diagnose it, attempt bounded repairs, and know whether the remaining blocker is physical access, Apple/account approval, or a missing preflight permission.
