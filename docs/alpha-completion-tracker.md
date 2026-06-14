# HivePlane Alpha Completion Tracker

Created: 2026-06-14

This is the active loop source for moving HivePlane from a strong dogfood demo to a small-team alpha that other humans can safely use.

## Completion Rule

Keep iterating until every item below is either shipped and verified on `main`, explicitly closed as stale/superseded, or intentionally deferred with a written reason.

## Priority Queue

1. **Auth, orgs, and operator roles** — issue #72
   - Goal: replace admin-token-only dogfood access with real operator identity and team/org separation.
   - Acceptance signal: a non-owner operator can sign in/use scoped dashboard actions without receiving owner/admin authority.

2. **Permission enforcement** — issue #32, paired with permissions UI #33
   - Goal: enforce scoped access around users, Bees, jobs/tasks, approvals, recovery actions, and audit visibility.
   - Current state: schema and design docs exist, but the live server still needs real checks and the dashboard needs management UI.
   - Acceptance signal: a user without `run` cannot create work for a System, a Bee without access is not routed that work, and a user without `approve` cannot approve high-risk work.

3. **Stale P0 issue cleanup** — issues #11 and #16 first
   - Goal: close or retitle issues that no longer describe reality after the recent OpenClaw task routing, control-plane API, incident, audit, automation, connector, and artifact work.
   - Acceptance signal: open P0s only represent real remaining blockers.

4. **Ollama backend adapter** — issue #39
   - Goal: make local model management product-grade instead of only reporting capabilities.
   - Acceptance signal: HivePlane can install/check Ollama, pull/list models, and expose usable model metadata for routing.

5. **OpenClaw sub-agent management** — issue #36
   - Goal: support adding/listing OpenClaw sub-agents if the pitch is managing agent fleets, not just generic OpenClaw task execution.
   - Acceptance signal: an operator can define or discover OpenClaw sub-agents and route work to them through HivePlane.

6. **CI workflow enablement** — issue #21
   - Goal: add GitHub Actions once repo workflow permissions allow it.
   - Current blocker: GitHub workflow permission.
   - Acceptance signal: PRs run format, typecheck, and tests automatically.

7. **Remote provisioning** — issue #19
   - Goal: SSH-based remote provisioning for smoother alpha onboarding.
   - Acceptance signal: an operator can point HivePlane at a reachable machine and get Bee installed/paired without manual copy-install steps.

8. **Fresh-machine demo hardening**
   - Goal: run the full 10-minute script from a totally fresh non-Chris machine and turn every rough edge into issues or fixes.
   - Acceptance signal: a fresh alpha tester can install, pair, route, inspect, cancel/retry, recover, and understand the audit trail without Chris-specific setup.

## Working Order

Start with #72 + #32 together because they turn HivePlane from a self-hosted control plane for dogfood into something a small AI-heavy team could trust.

After each shipped slice:

- update this tracker;
- update/close the matching GitHub issue;
- run `pnpm format:check`, `pnpm typecheck`, and `pnpm test` unless the change clearly does not touch code;
- restart the live Hive when the dashboard/API behavior changes;
- capture any fresh rough edges as follow-up issues instead of leaving them in chat.

## Iteration Log

### 2026-06-14 — Auth/Permission Core

Shipped the first #72/#32 backbone:

- operator tokens with owner/admin/operator/developer/viewer roles;
- default Systems: `infra`, `dev`, `personal`, `finance`, `public`;
- `GET /api/auth/me` and `GET /api/systems`;
- admin-gated operator creation;
- admin-gated System permission grants;
- admin-gated Bee System access grants;
- `POST /api/tasks` now requires `run` permission on the target System;
- task routing now filters out Bees without access to the target System;
- job approve/deny now require `approve` permission on the job target System;
- Hive state persistence now survives operators, Systems, user grants, and Bee access grants.

Still left in this area:

- dashboard UI for operators, Systems, user grants, and Bee access;
- broader operator checks on read/list/admin surfaces;
- real browser sign-in/session UX instead of raw operator bearer tokens;
- issue updates/closure after the UI and enforcement surface are broader.

### 2026-06-14 — Permissions UI

Shipped the first #33 dashboard pass:

- added a Permissions tab;
- operators can be created from the dashboard and their token is shown once;
- user System permission grants can be created from the dashboard;
- Bee System access grants can be created from the dashboard;
- current Systems, operators, user grants, and Bee access grants are visible in tables;
- the task form now includes a target System selector;
- the route preview now accounts for Bee System access, not only runtime/tool/model capability;
- operator tokens can read tasks/jobs through System `view` checks, and `run` permission implies view on that System for workflow usability.

Still left in this area:

- replace raw bearer-token workflow with a real sign-in/session UX;
- add revoke/delete/edit flows for operators and grants;
- extend scoped checks to more mutation surfaces such as recovery jobs, profile edits, automations, and incident/audit reads;
- add polish around roles so non-admin operators see only the controls they can actually use.
