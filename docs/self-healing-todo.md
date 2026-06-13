# HivePlane Self-Healing TODO

Goal: HivePlane should operate AI agent machines with an AI brain and constrained hands. The system should distinguish normal laptop/offline behavior from true incidents, use local/available AI to diagnose weird failures, auto-run safe repair tools, verify recovery, and escalate anything risky or unresolved.

## Product Model

- Add a per-Bee device expectation profile:
  - `availabilityClass`: `always_on`, `intermittent`, `ephemeral`, or `critical`
  - `offlineGraceSeconds`: how long silence is normal before the Bee is watched/escalated
  - `expectedWindows`: optional local-time windows when an intermittent machine should usually be online
  - `criticalServices`: health checks that matter for this Bee
  - `activeJobPolicy`: how offline behavior changes while jobs are active
  - `autoRepairWhenOnline`: whether diagnostics/repairs may run automatically after wake/reconnect
- Surface nuanced operational states:
  - `healthy`
  - `expected_offline`
  - `stale_watching`
  - `degraded`
  - `recovering`
  - `needs_approval`
  - `unresolved_incident`
- Treat laptops and travel machines differently from servers:
  - A Mac mini/server going stale quickly becomes an incident.
  - A MacBook Pro sleeping overnight is expected offline.
  - A MacBook Pro disappearing mid-job is an incident or blocked job.
  - A machine coming back online with Bee/Rescue/gateways broken is an incident.

## Automation Policy

- Auto-run only low-risk allowlisted actions:
  - restart/reload service
  - launchd bootstrap for a known plist
  - collect diagnostic logs
  - rerun health checks
- Keep approval required for:
  - arbitrary shell
  - installs/updates
  - config changes
  - destructive cleanup
  - credential/auth changes
  - broad "repair" actions that may install tools or alter external bridges
- Add circuit breakers:
  - max attempts per incident
  - cooldown between attempts
  - no duplicate active repair jobs for the same Bee/action
  - escalate after repeated failure

## AI Layer

- AI can inspect health checks, logs, recent jobs, service status, disk/memory/model state, and incident history.
- AI should classify incident type and choose from allowlisted repair tools.
- AI should write a plain-English incident summary and next-step recommendation.
- AI must not run arbitrary shell automatically.
- If the exact failure is new, AI can propose a repair plan that requires approval before any risky step.

## Build Checklist

- [x] Rescue Agent exists separately from Bee.
- [x] Rescue can restart/update Bee and collect logs.
- [x] Rescue can repair known gateway/iMessage paths locally.
- [x] Device expectation profile persisted per Bee.
- [x] Operational state computed from profile + health + jobs.
- [x] Incident model persisted in Hive state.
- [x] Auto-recovery evaluator queues safe runbook jobs.
- [x] Dashboard shows profile, operational state, incidents, and recovery history.
- [x] Local AI diagnosis/planner can produce a bounded repair recommendation.
- [x] Verification closes incidents only after health checks recover.
- [x] Notifications fire only for unresolved/approval-needed incidents.

## Remaining Follow-up

- Wire queued incident notifications to the eventual delivery channel (dashboard badge, iMessage, email, or webhook). The incident model now dedupes `needs_approval` and `unresolved` notifications, but delivery is intentionally separate.
- Add a dashboard profile editor so operators can change Bee profiles without calling the API directly.
