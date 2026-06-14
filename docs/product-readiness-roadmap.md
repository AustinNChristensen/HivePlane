# HivePlane Product Readiness Roadmap

HivePlane's wedge is personal and team AI infrastructure that makes local computers, agents, models, and automations reliable, observable, governable, and recoverable enough to trust with real workflows.

The product should prove three flows before widening:

1. Pair a new Mac and run useful work in under 10 minutes.
2. Delegate work to the right machine based on capabilities, models, permissions, and system access.
3. Break something, let Rescue diagnose or repair it, and show the audit trail.

## Usable Alpha

| Area                          | Status               | Notes                                                                                                                         |
| ----------------------------- | -------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Fresh Bee install and pairing | Mostly done          | Installer, pairing, Tailscale-first docs, and boring update path are in place. Keep improving #49 and #19.                    |
| Job lifecycle                 | Partly done          | Queue, assign, run, complete, fail, cancel, retry, events, and approvals exist. #16 remains the API hardening umbrella.       |
| Permissions                   | Partly done          | Systems schema, local Bee policy, and policy designs exist. Server-side system authorization and UI remain #32 and #33.       |
| Recovery                      | Strong dogfood slice | Recovery is first-class in the dashboard and Rescue handles real OpenClaw/iMessage/Bee paths. #76 expands evidence/artifacts. |
| Audit log                     | Partly done          | Basic audit events exist. Needs operator-grade filtering and permission-change coverage in #32/#76.                           |
| Auth and org separation       | Not done             | Tracked by #72.                                                                                                               |
| Dashboard core loop           | Partly done          | Bees, jobs, incidents, install scripts, logs, and profile surfaces exist. Systems/permissions UI remains #33.                 |
| 10-minute onboarding          | Partly done          | Demo script exists; product needs a polished first-run path after #49/#19/#33.                                                |

## Competitive Product

| Differentiator                                | Status      | Notes                                                                         |
| --------------------------------------------- | ----------- | ----------------------------------------------------------------------------- |
| Cross-machine delegation without SSH ceremony | Partly done | Bee pairing and capability routing exist; SSH provisioning is #19.            |
| Recovery as a product surface                 | Mostly done | Keep moving toward human-readable evidence and replay via #76.                |
| Permission profiles                           | Not done    | Tracked by #74.                                                               |
| Session continuity                            | Not done    | Tracked by #75.                                                               |
| Human-grade observability                     | Not done    | Tracked by #76.                                                               |
| Background automations                        | Not done    | Tracked by #77.                                                               |
| Local/cloud connectors                        | Not done    | Tracked by #78.                                                               |
| Installer/updater trust                       | Partly done | Fresh install is much better; TLS and remote provisioning remain #49 and #19. |

## Current Open Roadmap

Near-term product blockers:

- #49 TLS / HTTPS on Bee-to-Hive traffic.
- #72 basic auth, org/team separation, and operator roles.
- #32 server-side permission checks for users, Bees, jobs, and approvals.
- #33 Systems, users, and Bee permissions UI.
- #19 SSH-based remote provisioning.
- #16 control-plane API hardening around scoped permissions.

Runtime and model depth:

- #39 Ollama backend adapter install/start/smoke/runtime consumption.
- #11 OpenClaw runtime adapter.
- #12 Hermes runtime adapter.
- #36 OpenClaw sub-agent management.
- #37 Hermes sub-agent management.

Competitive expansion:

- #74 permission profiles.
- #75 session continuity.
- #76 human-grade observability artifacts.
- #77 background automations.
- #78 connector framework.

## Product Rule

Do not build fifty shallow features. Finish the 2-3 proof flows until they are boring:

- Install and pair.
- Route and run.
- Break, recover, explain.
