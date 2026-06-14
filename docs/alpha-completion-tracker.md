# HivePlane Alpha Completion Tracker

Created: 2026-06-14

This is the active loop source for moving HivePlane from a strong dogfood demo to a small-team alpha that other humans can safely use.

## Completion Rule

Keep iterating until every item below is either shipped and verified on `main`, explicitly closed as stale/superseded, or intentionally deferred with a written reason.

## Priority Queue

1. **Auth, orgs, and operator roles** — issue #72
   - Goal: replace admin-token-only dogfood access with real operator identity and team/org separation.
   - Acceptance signal: a non-owner operator can sign in/use scoped dashboard actions without receiving owner/admin authority.
   - Status: shipped and dogfooded on 2026-06-14. Operator sessions, default organization migration, org-scoped operators/Systems, org-aware admin boundaries, and session logout/revoke are on main; #72 closed.

2. **Permission enforcement** — issue #32, paired with permissions UI #33
   - Goal: enforce scoped access around users, Bees, jobs/tasks, approvals, recovery actions, and audit visibility.
   - Acceptance signal: a user without `run` cannot create work for a System, a Bee without access is not routed that work, and a user without `approve` cannot approve high-risk work.
   - Status: core P0 enforcement shipped and dogfooded on 2026-06-14. Task creation/routing, job approvals, job/task control actions, automation controls, audit visibility, and incident visibility now use System-scoped permissions. Remaining polish overlaps with #72 real sign-in/session UX and can be tracked separately.

3. **Stale P0 issue cleanup** — issues #11 and #16 first
   - Goal: close or retitle issues that no longer describe reality after the recent OpenClaw task routing, control-plane API, incident, audit, automation, connector, and artifact work.
   - Acceptance signal: open P0s only represent real remaining blockers.
   - Status: #11 and #16 closed on 2026-06-14 as stale/completed umbrellas; remaining runtime work is tracked by #36/#39 and remaining auth hardening by #32/#33/#72.

4. **Ollama backend adapter** — issue #39
   - Goal: make local model management product-grade instead of only reporting capabilities.
   - Acceptance signal: HivePlane can install/check Ollama, pull/list models, and expose usable model metadata for routing.
   - Status: first implementation shipped on 2026-06-14 with explicit `install_model_backend`, `ollama_start`, `ollama_pull_model`, `ollama_list_models`, `ollama_status`, and `ollama_smoke_test` daemon paths plus dashboard actions. Live Chris Mac mini dogfood has passed status, start, pull, list, and smoke inference. Remaining OpenClaw/Hermes consumption is product polish and can be tracked separately.

5. **OpenClaw sub-agent management** — issue #36
   - Goal: support adding/listing OpenClaw sub-agents if the pitch is managing agent fleets, not just generic OpenClaw task execution.
   - Acceptance signal: an operator can define or discover OpenClaw sub-agents and route work to them through HivePlane.
   - Status: first implementation shipped on 2026-06-14 with Hive sub-agent definitions, Sub-agents dashboard tab, Bee-reported sub-agent capabilities, daemon list/configure/delete/smoke adapter jobs, task routing by requested sub-agent, and daemon prompts/session keys that use the configured sub-agent. Live Chris Mac mini dogfood passed create -> reconcile -> approve -> configure -> heartbeat report -> named sub-agent task execution. Remaining polish can be tracked separately: smoke-test UI action if needed, cleanup/edit/delete UX, and any deeper native OpenClaw config integration once OpenClaw exposes a richer API.

6. **CI workflow enablement** — issue #21
   - Goal: add GitHub Actions once repo workflow permissions allow it.
   - Current blocker: GitHub workflow permission.
   - Acceptance signal: PRs run format, typecheck, and tests automatically.

7. **Remote provisioning** — issue #19
   - Goal: SSH-based remote provisioning for smoother alpha onboarding.
   - Acceptance signal: an operator can point HivePlane at a reachable machine and get Bee installed/paired without manual copy-install steps.
   - Status: first CLI implementation shipped on 2026-06-14. `hive node provision ssh <user@host>` now runs a remote prerequisite healthcheck, mints a one-use bootstrap token, streams the normal Bee installer over SSH, applies a provisioning profile mapped to a Bee policy profile, and starts the Bee. Remaining hardening belongs in the fresh-machine pass: live non-Chris host dogfood and any host-specific prerequisite UX.

8. **Fresh-machine demo hardening**
   - Goal: run the full 10-minute script from a totally fresh non-Chris machine and turn every rough edge into issues or fixes.
   - Acceptance signal: a fresh alpha tester can install, pair, route, inspect, cancel/retry, recover, and understand the audit trail without Chris-specific setup.
   - Status: executable pass script added on 2026-06-14 in `docs/fresh-machine-demo-pass.md`. True end-to-end proof is blocked until there is a reachable fresh non-Chris SSH host; current live Bees are healthy, but Austin MBP is already paired and does not prove first onboarding.

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

### 2026-06-14 — Hive Approval Marker

Shipped a #32 enforcement fix:

- Hive approval now stamps `payload.hiveApproval` with `approvedAt` and `approvedBy`;
- Bee local policy treats approval-required job types as allowed only when that Hive approval marker is present;
- explicit local policy denies still win.

Live approval dogfood:

- removed `openclaw_subagent_configure/delete` from the live Chris Mac mini Bee's local job allowlist;
- reconciled sub-agent `subagent_3e4d123a0562324a`;
- Hive queued job `job_a230ed29fee98c71` as `waiting_for_approval`;
- approval response included `hiveApproval` with `approvedBy=admin-token`;
- Bee accepted and completed the job successfully because local policy recognized the Hive approval marker.

### 2026-06-14 — Scoped Control Surfaces

Shipped another #32 enforcement slice:

- job cancel/retry now require operator auth plus `run` on the job target System;
- task retry/cancel now require operator auth plus `run` on the task target System;
- automation list filters by System `view`;
- automation create/run/trigger require `run` on the automation target System;
- automation pause/resume require `admin` on the automation target System;
- audit log and incident list require `audit` on at least one System;
- incident notification delivery remains admin-role gated.

Verification:

- full `pnpm format:check`, `pnpm typecheck`, and `pnpm test` passed;
- server tests cover a finance-scoped operator creating/cancelling tasks, creating/listing automations, being denied audit without `audit`, then being allowed after an audit grant.

### 2026-06-14 — Operator Sessions

Shipped the next #72 auth slice:

- added `hp_op_sess_...` operator dashboard sessions separate from durable `hp_user_...` operator tokens;
- added `POST /api/auth/login` to exchange an owner/admin/operator token for a persisted 30-day operator session;
- kept the self-host owner fallback path working by allowing the admin token to mint an owner session;
- updated the dashboard sign-in popover to store only the returned session token in local storage, clearing the durable pasted token after exchange;
- persisted operator sessions in `hive-state.json`;
- added server tests for operator-token exchange, session reuse, and expired-session rejection.

Verification:

- full `pnpm format:check`, `pnpm typecheck`, and `pnpm test` passed;
- live Hive was restarted;
- live owner-session smoke passed through `/api/auth/login`, `/api/auth/me`, and `/api/tasks`;
- live non-owner viewer smoke created operator `user_e9df6a23c0fd2217`, exchanged its token for a `hp_op_sess_...` session, and verified `/api/auth/me` returned that viewer identity.

### 2026-06-14 — Organization Boundaries And Logout

Closed out the remaining #72 P0 work:

- added an explicit default organization model and `GET /api/organizations`;
- operators and Systems now carry an `organizationId`;
- existing persisted operators and Systems migrate into `org_default`;
- non-owner admin/operator permissions are constrained to their own organization;
- operator lists, permission grants, and Bee System access grants are filtered/guarded by organization boundary;
- added `DELETE /api/auth/session` plus dashboard Sign out to revoke the current operator session;
- added server coverage proving a default-org admin cannot see or grant into a second org while that org's admin can see its own System;
- extended session tests to verify revoked sessions are rejected.

Verification:

- full `pnpm format:check`, `pnpm typecheck`, and `pnpm test` passed;
- live Hive was restarted;
- live smoke passed `/api/auth/login`, `/api/organizations`, `/api/systems`, `DELETE /api/auth/session`, and rejected the revoked session with 401.

### 2026-06-14 — Ollama Backend Adapter

Shipped the first #39 implementation:

- protocol now includes explicit `ollama_start`, `ollama_pull_model`, and `ollama_smoke_test` job types;
- Bee executor handles `install_model_backend` for Ollama on macOS Homebrew, including dry-run plan and `brew services start ollama`;
- Bee executor handles named Ollama pull jobs without relying on `configure_model` as a side effect;
- Bee executor handles local smoke-test inference via `ollama run <model> <prompt>`;
- dashboard Bee actions include Ollama status, model list, smoke model, pull model, and start Ollama;
- `ollama_smoke_test` is auto-approved; pull/install/start still route through the existing approval path.

Polish left in this area:

- configure OpenClaw/Hermes to consume the reported Ollama endpoint/model where those runtimes support local backend selection;

Live dogfood notes:

- Chris Mac mini Bee reported Ollama installed/running with version `0.30.7`, endpoint `http://127.0.0.1:11434`, and model `gemma4:12b`;
- `ollama_status`, `ollama_list_models`, and `ollama_smoke_test` jobs succeeded against the live Bee;
- follow-up daemon cleanup sanitizes Ollama progress escape sequences before storing stdout/stderr or event artifacts.
- approval-gated `ollama_start` job `job_4e0982cb531657c2` succeeded and confirmed Ollama running;
- approval-gated `ollama_pull_model` job `job_bf4b5b1f0c0da1d7` succeeded for existing model `gemma4:12b`;
- `ollama_list_models` job `job_3810db3b60a778c0` confirmed `gemma4:12b` after the pull path.

### 2026-06-14 — OpenClaw Sub-agent Management

Shipped the first #36 implementation:

- protocol now includes Bee-reported `subAgents` plus OpenClaw sub-agent adapter job types;
- Bee daemon persists managed OpenClaw sub-agent definitions in a HivePlane-scoped `openclaw-sub-agents.json` registry;
- daemon adapter jobs can list, configure, delete, and smoke-test managed OpenClaw sub-agents;
- Hive stores desired sub-agent definitions, exposes `/api/sub-agents`, and queues reconcile jobs to eligible Bees;
- task creation accepts `requestedSubAgentId`, route preview accounts for reported sub-agents, and scheduler only assigns that task to a Bee reporting the requested sub-agent;
- dashboard now has a Sub-agents tab for defining/reconciling OpenClaw sub-agents, and the task form can target one.

Polish left in this area:

- add a dashboard smoke action for configured sub-agents if it feels necessary after dogfood;
- add edit/delete UX for definitions and cleanup of dogfood definitions;
- replace the HivePlane-scoped registry with native OpenClaw config/list operations if/when OpenClaw exposes them.

Live dogfood notes:

- first reconcile attempt exposed that the live Bee's `~/.hiveplane/policy.json` was still strict `{ runCommand.allow }`; added a narrow local job allowlist for OpenClaw observe/sub-agent/agent-task jobs;
- after Bee restart, sub-agent `subagent_18530298ed5b4f16` configured successfully via job `job_9d45e87e3d46cc8f`;
- Chris Mac mini Bee heartbeat reported the configured sub-agent within five heartbeat checks.
- live task `task_67d29386f649aacd` assigned to job `job_6fddb6893f854bea`, used session key `hiveplane-subagent-subagent_18530298ed5b4f16-task-task_67d29386f649aacd`, stored `subAgentId`, and returned `hiveplane-subagent-task-ok`.
- add richer model metadata beyond names and endpoint URL.

### 2026-06-14 — SSH Remote Provisioning

Shipped the first #19 implementation:

- `hive node provision ssh <user@host>` now performs a harmless SSH prerequisite healthcheck before doing anything stateful;
- the healthcheck verifies a remote shell plus required bootstrap prerequisites: `curl`, `git`, and Node 20+;
- the provisioner accepts `--hive-url`, or discovers a URL from local Hive config and hostname;
- it mints a single-use bootstrap token through `/api/bootstrap-tokens` using the local Hive admin token or `--token`;
- it streams a remote `sh -s` bootstrap script over SSH instead of storing SSH credentials;
- the remote script runs the existing `/install/bee.sh` one-command flow with `HIVEPLANE_HIVE_URL`, `HIVEPLANE_BOOTSTRAP_TOKEN`, and `HIVEPLANE_NO_START=1`;
- after install/pairing, it applies a selected provisioning profile (`macos-openclaw`, `linux-openclaw`, `server-worker`, `dev-box`, `read-only`) mapped onto an existing Bee policy profile, then starts the Bee service and prints `bee status`;
- `--healthcheck-only`, `--dry-run`, `--ssh-bin`, and `--json` are available for first-run troubleshooting and scripted use;
- README now documents the SSH path and explicitly says HivePlane does not persist SSH passwords/private keys for the MVP.

Verification:

- `pnpm --filter @hiveplane/cli typecheck` passed;
- `pnpm --filter @hiveplane/cli test` passed, including fake-SSH healthcheck and dry-run coverage;
- full `pnpm format:check`, `pnpm typecheck`, and `pnpm test` passed after the implementation;
- manual dry-run JSON smoke passed for `hive node provision ssh austin@example --hive-url http://hive.tailnet.test:4483 --profile server-worker --dry-run --json`.

Fresh-machine pass still needs a real non-Chris reachable host to prove end-to-end network/prerequisite assumptions, then file/fix any rough edges found there.

### 2026-06-14 — Fresh-Machine Demo Pass Setup

Added `docs/fresh-machine-demo-pass.md` as the executable alpha onboarding checklist:

- host prerequisites;
- exact SSH healthcheck command;
- exact SSH provision command;
- dashboard verification steps;
- first healthcheck job;
- demo routed agent task;
- cancel/retry/audit check;
- safe Rescue recovery step;
- rough-edge capture rule.

Current status:

- live Hive is healthy;
- Chris Mac mini Bee is online/healthy with Rescue online;
- Austin MBP Bee is online/healthy with Rescue online;
- Tailscale did not return a node list from this Hive box;
- Austin MBP is already paired, so it cannot prove fresh onboarding;
- true fresh-host proof is blocked until a clean reachable host is available.

Pre-real-host rough edges already identified:

- `--hive-url` needs to be an actually routable Tailnet/LAN URL; config discovery is useful but not magic;
- the SSH healthcheck now catches missing Node 20/git/curl up front, but HivePlane still does not install Node itself;
- provisioning is CLI-only; a dashboard wizard remains future polish.
