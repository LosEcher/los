# ADR 0023: Agent Identity Decision Framework

**Date:** 2026-06-18

**Status:** implemented (Phase 0-1)

## Context

los has six distinct agent execution paths (gateway chat, child spawn, remote executor, scheduler graph, self-check judge, pre-execution phases). Before this ADR, all agents used the same hardcoded system prompt: `"You are a helpful coding assistant with access to tools..."`. There was no notion of a named agent identity, a consistent persona, or persistent character traits.

The user's workspace defines four files for a digital entity:
1. **AGENTS.md** — operating rules, boundaries, heartbeat management
2. **SOUL.md** — core values, temperament, boundaries
3. **MEMORY.md** — long-term memory index, event log, crystallized insights
4. **IDENTITY.md** — name, role, style, signature

The question: which of these patterns apply to los's multi-agent architecture, and at what depth?

## Decision

### Identity Levels

Four levels of identity injection, from none to full:

| Level | Description | Context Budget |
|-------|-------------|---------------|
| `none` | No identity injected. Empty string. | 0 tokens |
| `minimal` | One-line role label: `"You are [role]."` | ~5 tokens |
| `standard` | Multi-block: name, role, style, values, boundaries, heartbeat | ~50-80 tokens |
| `full` | Standard + backstory narrative from SOUL.md body | ~150+ tokens |

### Per-Path Decision Matrix

| Execution Path | Identity Level | Justification |
|---|---|---|
| **Gateway Chat** | Standard | Primary user-facing path. Long-running sessions. Identity impacts interaction quality and trust. |
| **Child/Spawned** | Minimal | Short-lived (max 12 loops), single-purpose, constrained tools. Identity would waste context budget on a 3-turn search task. |
| **Remote Executor** | Minimal | Network boundary — remote node may not have `.los/identity/` files. Functional label only: `"[los executor node: <nodeId>]"`. |
| **Scheduler Graph (executor/planner)** | Standard | Code-generation and planning tasks benefit from identity. |
| **Scheduler Graph (verifier)** | None | Verification tasks must remain objective. Identity = bias. |
| **Self-Check Judge** | None | Uses a different provider/model to avoid self-affirmation bias. Injecting persona would undermine its role as an objective evaluator. |
| **Pre-Execution Phases** | Minimal | Intermediate phases produce reports, not final output. Phase context is already injected via user messages. |

### Resolution Chain

```
project (.los/identity/<name>/) → user (~/.los/identity/<name>/) → system (/etc/los/identity/<name>/) → built-in default
```

Mirrors the los config resolution chain. Each layer partially overrides — setting only `style` at project level inherits `name`, `role`, etc. from lower layers.

### Injection Points

1. **Gateway path**: `augmentChatSystemPrompt()` in `chat-memory-augment.ts` — identity block prepended before base prompt, before memory augmentation
2. **Non-gateway paths** (child, scheduler, executor): `runAgent()` in `loop.ts` — identity resolved and composed with default prompt only when `systemPrompt` is not explicitly set
3. **Config**: `config.agent.identity.name` and `config.agent.identity.level` control defaults; `AGENT_IDENTITY_NAME` and `AGENT_IDENTITY_LEVEL` env vars override

## Consequences

### Positive

- Agents now have recognizable identities appropriate to their role
- Identity injection is opt-in per path — paths that don't benefit (judge, verifier) get zero overhead
- Resolution chain allows project-level customization without modifying source code
- File-based identity definition (`.los/identity/`) is human-readable and version-controllable

### Negative

- Added ~260 lines of new code (identity-loader.ts)
- Identity files must be maintained and kept consistent with agent behavior
- Child agents receive a different persona than the parent — could cause confusion if the child's constrained identity produces output that doesn't match parent expectations

### Neutral / Watch Items

- Full-level identity is designed but not yet implemented (deferred to Phase 3)
- Memory personalization (agent self-reflection, observer_type dimension) is deferred to Phase 2
- The `config.agent.systemPrompt` dead wire was fixed as a side effect — it now works as a global override

## Alternatives Considered

### A. Single global identity for all agents
Rejected: would waste context budget on short-lived child agents and bias the self-check judge.

### B. Identity as part of the base system prompt string
Rejected: loses the per-agent differentiation and the file-based resolution chain.

### C. No identity system at all (status quo)
Rejected: "helpful coding assistant" is too generic for a multi-agent platform with distinct roles.
