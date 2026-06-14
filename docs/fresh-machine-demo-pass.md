# Fresh-Machine Demo Pass

Created: 2026-06-14

Goal: prove a non-Chris operator can get from zero to first useful Bee in about 10 minutes, then route work, inspect what happened, and recover from a rough edge without Chris-specific setup.

## Test Host Requirements

- macOS or Linux machine not already paired as a HivePlane Bee.
- Reachable from the Hive box over SSH using the operator's local SSH agent/config.
- Node 20+, git, curl, and a POSIX shell available before provisioning.
- Able to reach the Hive URL supplied to `--hive-url` (usually a Tailscale MagicDNS name, Tailnet IP, or trusted LAN URL).
- No SSH password/private key should be entered into or stored by HivePlane.

## Ten-Minute Script

1. From the Hive box, verify SSH and prerequisites:

   ```bash
   hive node provision ssh user@host \
     --hive-url http://<hive-tailnet-or-lan-host>:4483 \
     --profile macos-openclaw \
     --healthcheck-only
   ```

2. Provision the Bee:

   ```bash
   hive node provision ssh user@host \
     --hive-url http://<hive-tailnet-or-lan-host>:4483 \
     --profile macos-openclaw \
     --name alpha-laptop-1
   ```

3. Open `/dashboard`, sign in, and confirm:
   - the Bee appears within one heartbeat interval;
   - `status=online`;
   - Rescue is online after service startup;
   - policy/profile is visible and understandable.

4. Queue a healthcheck job against the new Bee and inspect:
   - job status;
   - Bee name;
   - events;
   - artifacts/output.

5. Queue a demo agent task with explicit requirements and confirm route preview explains why this Bee was selected or rejected.

6. Exercise task/job controls:
   - cancel a queued/running job;
   - retry it;
   - confirm audit entries show who did what.

7. Trigger one safe recovery path:
   - collect Bee logs, or
   - restart Bee through Rescue.

8. Record every confusing step as either an immediate fix or a GitHub issue.

## Current Pass Status

2026-06-14:

- #19 SSH provisioning implementation is shipped in `95a8c9b`.
- Full repo verification passed: `pnpm format:check`, `pnpm typecheck`, and `pnpm test`.
- CLI dry-run smoke passed:

  ```bash
  hive node provision ssh austin@example \
    --hive-url http://hive.tailnet.test:4483 \
    --profile server-worker \
    --dry-run \
    --json
  ```

- CLI healthcheck dry-run smoke passed:

  ```bash
  hive node provision ssh ops-box \
    --hive-url http://hive.tailnet.test:4483 \
    --profile macos-openclaw \
    --healthcheck-only \
    --dry-run
  ```

- Live Hive state at pass time:
  - Chris Mac mini: online / healthy / Rescue online.
  - Austin MBP: online / healthy / Rescue online.

Blocked for the true fresh-machine proof: this Hive box does not currently expose a reachable fresh non-Chris SSH host. Tailscale status returned no node list, and Austin MBP is already paired, so using it would not prove first-time onboarding.

## Rough Edges Found Before Real-Host Dogfood

- The SSH provisioner needs the operator to know a routable Hive URL. Discovery can fall back to `http://<hostname>:4483`, but alpha testers will usually need a Tailscale/LAN URL in the command.
- Fresh hosts without Node 20, git, or curl fail at healthcheck now, which is clearer than failing mid-install, but the installer still does not install Node for them.
- The dashboard does not yet have a "Provision over SSH" wizard, so #19 is CLI-only for this alpha slice.
