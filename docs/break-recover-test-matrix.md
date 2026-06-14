# HivePlane Break/Recover Test Matrix

Purpose: prove self-healing with real services, real alerts, and reversible failures before packaging the next release.

## Preconditions

- Hive is running on the Mac mini and `/healthz` returns OK.
- Mac mini Bee and Rescue both report online.
- Incident notification delivery is configured through either `HIVEPLANE_INCIDENT_NOTIFY_COMMAND` or `HIVEPLANE_INCIDENT_WEBHOOK_URL`.
- The operator has the current Hive admin token available.

## Matrix

| Scenario                           | Setup                                                                                            | Expected result                                                                                          | Pass signal                                                                                 |
| ---------------------------------- | ------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Stop Bee while Rescue stays online | `launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.hiveplane.bee.plist`                  | Hive opens a Bee offline incident, Rescue receives `restart_bee`, Bee returns online, verification runs. | Incident reaches `resolved`; Bee `operationalState` returns `healthy`; no duplicate alerts. |
| Stop OpenClaw gateway              | Stop only the OpenClaw gateway process/service, leaving Bee and Rescue online.                   | Bee reports `openclaw-gateway` failing, Hive queues `restart_openclaw_gateway`, verification runs.       | Gateway health check returns `passing`; incident resolves after verification.               |
| Deny a risky repair                | Queue an approval-gated job such as `update_bee`, then deny it in the dashboard.                 | Job remains contained and records the denial.                                                            | No automatic retry of a denied risky action; dashboard explains the denied state.           |
| Force verification failure         | Create a health incident where the repair job succeeds but the health condition remains failing. | Hive keeps the incident out of `resolved` and escalates to `unresolved`.                                 | One concise unresolved alert is delivered; retries obey cooldown/max attempts.              |
| Profile editor good path           | Save Mac mini as `always_on`, MBP as `intermittent`, and tweak grace windows.                    | API persists normalized values; dashboard reflects states after refresh.                                 | Mac mini stays `healthy`; MBP can be `expected_offline` without alerting.                   |
| Profile editor bad combinations    | Try a critical profile with long grace, no critical services, or auto-repair off.                | Save is allowed when structurally valid but warnings are shown; invalid values are rejected.             | API returns warnings or HTTP 400 with a clear reason; dashboard shows the hint.             |
| Notification retry                 | Configure a failing notifier, trigger an alert, then restore the notifier and force delivery.    | Notification moves `queued` -> `failed` -> `sent` without creating duplicates.                           | Delivery attempts increment; one notification record per incident status.                   |

## Release Gate

- All scenarios above are either passed or documented with a specific follow-up issue.
- `pnpm typecheck` and `pnpm test` pass.
- Live dashboard screenshots/API snapshots show no stale unresolved incidents after cleanup.

## Dogfood Log

- 2026-06-13: Profile editor/API validation dogfooded against the live Hive.
  - Invalid `offlineGraceSeconds: 0` returned HTTP 400 with a clear reason.
  - Critical profile with long grace, auto-repair off, and no critical services saved with warnings.
  - Mac mini restored to `always_on` / 120s grace; MBP restored to `intermittent` / 12h grace.
- 2026-06-13: Mac mini Bee stop/recover passed.
  - Booted out `com.hiveplane.bee` while Rescue stayed online.
  - Hive opened `bee_offline`, queued `restart_bee`, ran post-repair `run_healthcheck`, and resolved the incident.
  - Final state: Bee online, Rescue online, operational state `healthy`.
  - Follow-up fixed in this pass: short profile grace windows now take effect before the old 2-minute stale threshold.
