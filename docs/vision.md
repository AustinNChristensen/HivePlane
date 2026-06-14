# HivePlane Vision

HivePlane is the setup and operations layer for multi-device AI systems.

It lets a person or organization connect many AI systems, machines, users, skills,
tools, and local models into one governed mesh, then keep that mesh observable,
permissioned, and recoverable.

The model is inspired by infrastructure products like Vercel, Tailscale, and Kubernetes, but focused on AI agent execution:

- Agents run close to user machines, company systems, repos, browsers, tools, and local models.
- A central control plane manages identities, permissions, skills, configuration, approvals, observability, and fleet state.
- Machines can use each other through governed capabilities instead of ad hoc SSH, one-off scripts, or fully trusted bot accounts.
- The open-source core remains useful without the hosted cloud.

## Positioning

> The open-source control plane for multi-device AI systems.

Alternative one-liners:

- Connect your agents, machines, users, models, tools, and skills into one governed AI mesh.
- The first step for setting up company, startup, or home AI infrastructure.
- Run agents locally. Govern and recover them centrally.
- Provision, observe, permission, and self-heal AI-capable machines.
- Tailscale-style coordination plus RMM-style recovery for AI agents.

## Product Wedge

The wedge is not simply "hosted AI agents" or "agent observability."

The wedge is:

> Bring your own machines, tools, data, agents, skills, and local models — then make them work together under one permissioned, self-healing control plane.

HivePlane should be the first install when someone wants to turn scattered AI tools into a durable system:

1. **Connect** machines, runtimes, models, tools, gateways, and skills.
2. **Govern** which users, agents, and machines may use which capabilities.
3. **Delegate** tasks to Bee computers as sub-agents of the Hive.
4. **Coordinate** work across devices and AI systems without hand-wired access.
5. **Observe** health, jobs, queues, capabilities, traces, and audit history.
6. **Recover** failed agents, gateways, and machines through safe repairs, verification, and alerts.

The core user is not only "a developer running agents." It is anyone operating a multi-device AI environment:

- a home lab with Mac minis, laptops, local models, and personal agents;
- a startup with several team agents, repo bots, customer support bots, and internal tools;
- a company that wants private/on-prem agents with real permissions and auditability;
- an agency or consultant managing many client-owned agent boxes.

## Permission Model

HivePlane needs permissions across four first-class subjects:

- **Users**: humans who request work, approve repairs, and own credentials.
- **Machines**: Macs, Linux boxes, servers, laptops, and future cloud sandboxes.
- **Agents/runtimes**: OpenClaw, Hermes, Codex CLI, OpenHands-like workers, voice agents, and future runtimes.
- **Skills/capabilities**: tools, connectors, scripts, MCP servers, models, files, apps, gateways, and external APIs.

The important product promise:

> No agent, user, or machine should get broad ambient access just because it joined the mesh.

Capabilities should be granted deliberately, audited, and revocable.

## Product Pillars

### 1. Mesh Setup

- Install a Bee on each device.
- Pair it with the Hive.
- Discover local runtimes, models, gateways, tools, and skills.
- Make the device available to the AI system without manual SSH setup.

### 2. Capability Registry

- Inventory what each machine can do.
- Register skills/tools/models as capabilities.
- Let machines and agents request use of other capabilities through policy.
- Track versions, health, owner, required secrets, and risk level.

### 3. Sub-Agent Task Delegation

- Treat each Bee computer as an assignable sub-agent seat in the Hive.
- Route tasks to Bees based on runtime availability, skills, local tools, model inventory, permissions, and current operational state.
- Let the Hive break larger requests into scoped subtasks and send them to the best available Bee.
- Keep Bee task execution auditable: who requested it, which agent/runtime handled it, what capability was used, and what result came back.
- Avoid dispatching work to Bees that are expected-offline, degraded, recovering, or missing required permissions.

### 4. Access Control

- Assign users, groups, agents, machines, and skills to policies.
- Gate risky operations behind approval.
- Keep sensitive systems scoped to the right humans and agents.
- Prefer least-privilege grants over all-powerful bot accounts.

### 5. Operations + Recovery

- Health checks for machines, runtimes, gateways, local models, queues, and skills.
- Device expectation profiles for always-on servers vs intermittent laptops.
- Rescue Agent for out-of-band recovery when the primary Bee fails.
- AI-assisted diagnosis inside a constrained repair system.
- Verification and alerting before calling an incident solved.

### 6. Audit + Source Of Truth

- Show which agents are running, what they can access, what they did, and whether the work succeeded.
- Preserve approval history, repair attempts, job logs, and capability changes.
- Give operators confidence that the AI system is actually alive and doing useful work.

## Why Open Source First?

Agent infrastructure is trust-sensitive. Developers and companies need to understand:

- what runs locally;
- what data leaves the machine;
- how secrets are handled;
- how user, machine, and skill permissions are enforced;
- which tools agents can call;
- which actions require approval;
- how failures are repaired;
- how to self-host if needed.

Open source lowers adoption friction and makes the hosted enterprise product easier to trust.

## Future Managed Enterprise Product

The managed version can monetize:

- hosted control plane;
- team/org management;
- enterprise RBAC/SSO;
- managed audit retention;
- fleet observability;
- capability registry and policy packs;
- hosted relay/networking;
- secrets integrations;
- hosted trace/event retention;
- priority support;
- compliance features.
