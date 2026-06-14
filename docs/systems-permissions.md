# Systems And Scoped Permissions

HivePlane needs a first-class "System" model so access is scoped to a named domain instead of granted ambiently to every user, Bee, agent, or skill.

Examples:

- `dev`
- `infra`
- `finance`
- `personal`
- `marketing`
- `github`
- `quickbooks`
- `customer:<slug>`

## Core Objects

### System

A System is an access domain with:

- id;
- organization id;
- slug;
- display name;
- risk tier;
- owner;
- optional description;
- archived/revoked state;
- audit metadata.

### User Permissions

Users have independent permissions per System:

- `view`: inspect state/logs for that System;
- `run`: create jobs/tasks targeting that System;
- `approve`: approve sensitive jobs/tasks targeting that System;
- `admin`: manage access and policies for that System;
- `audit`: inspect audit history and incident/recovery history.

`admin` implies management, not automatic execution. Execution and approval should still be separately visible in audit logs.

### Bee Access

Bees can have:

- `none`: never receive jobs for this System;
- `limited`: receive jobs only for explicitly granted Systems;
- `universal`: candidate for all Systems in the org, still subject to local policy and health.

Limited access should be the default for sensitive machines. Universal access is convenient for dogfood/dev boxes but should be auditable.

### Job/Task Target

Every job/task that touches user data, tools, repos, apps, credentials, or external systems should carry:

- `targetSystemId`;
- requester/actor;
- requested capability;
- risk level;
- approval state.

Pure fleet health jobs can target an internal System such as `infra` or `fleet`.

## Permission Checks

### Create Job Or Task

1. Resolve requester identity.
2. Resolve target System.
3. Require user `run` permission for the target System.
4. Record audit event: `job.create` or `task.create`.

### Route Job Or Task

1. Filter Bees by online/healthy/recoverable state.
2. Filter by runtime/tool/model/capability requirements.
3. Filter by Bee access to the target System.
4. Prefer least-privileged Bee that satisfies the request.

### Approval

1. Require user `approve` permission for the target System.
2. Deny self-approval for high-risk operations if policy requires separation.
3. Record approval decision, actor, reason, and scope.

### Admin Changes

1. Require user `admin` permission for the affected System or org-level owner/admin role.
2. Audit changes to user permissions, Bee access, universal grants, policy packs, and archived Systems.

## MVP Defaults

Seed these Systems for dogfood:

- `infra`: Hive/Bee/Rescue operations, service restarts, installers, networking.
- `dev`: repos, local dev commands, coding-agent tasks.
- `personal`: personal assistant workflows, Messages/Mail/Calendar-style local apps.
- `finance`: finance/accounting tools, high-risk by default.
- `public`: low-risk demos and sample tasks.

## Data Model Direction

Implementation should add:

- `systems`;
- `user_system_permissions`;
- `bee_system_access`;
- `jobs.target_system_id`;
- `tasks.target_system_id`;
- audit events for access changes and permission checks.

## Non-Goals

- Replacing local Bee policy. Hive authorization decides whether work may be assigned; local policy still decides whether this machine will execute it.
- Treating RBAC roles alone as enough. System-scoped permissions are the product boundary.
- Letting Tailscale membership imply app authorization.

## Acceptance Signal

A finance-connected Bee should be able to reject or never receive a dev task, and a dev-only operator should not be able to approve a finance task, even if both use the same Hive.
