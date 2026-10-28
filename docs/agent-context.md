# Agent Context

## Purpose

HivePlane is an open-source AI-agent control/management plane for AI-first startups and small companies: multiple agents, machines, models, permissions, monitoring, and self-healing.

## Durable implementation direction

The early architecture includes organization/user/agent identity, tokens, jobs, events, approvals/audit, persistent Ed25519 agent identity, Tailscale Hive/Bee connectivity, supervisor health checks, and append-only incident logs.

## Source of truth

The repository, issues, and current smoke checks own the implementation state. This document is intentionally not a changelog.
