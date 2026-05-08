# HivePlane Vision

HivePlane is a control plane for fleets of AI-capable worker nodes.

The model is inspired by infrastructure products like Vercel, Tailscale, and Kubernetes, but focused on AI agent execution:

- Agents run close to user machines, repos, browsers, tools, and local models.
- A central control plane manages configuration, approvals, observability, and fleet state.
- The open-source core remains useful without the hosted cloud.

## Positioning

> The open-source control plane for agent hives.

Alternative one-liners:

- Manage AI agent fleets across your own machines.
- Run agents locally. Control them centrally.
- Provision, observe, and govern worker nodes for AI agents.
- Tailscale-style coordination for local AI agents.

## Product Wedge

The wedge is not simply “hosted AI agents.”

The wedge is:

> Bring your own machines, tools, data, and local models — then manage the resulting agent fleet with cloud-grade operations.

## Why Open Source First?

Agent infrastructure is trust-sensitive. Developers and companies need to understand:

- what runs locally;
- what data leaves the machine;
- how secrets are handled;
- which tools agents can call;
- which actions require approval;
- how to self-host if needed.

Open source lowers adoption friction and makes the hosted enterprise product easier to trust.

## Future Managed Enterprise Product

The managed version can monetize:

- hosted control plane;
- team/org management;
- enterprise RBAC/SSO;
- managed audit retention;
- fleet observability;
- policy packs;
- hosted relay/networking;
- secrets integrations;
- priority support;
- compliance features.
