---
name: agent-identity
description: Agent identity resolution, prompt formatting, and decision framework. Defines which agent execution paths get which identity level and why.
---

# agent-identity — Agent Identity System Spec

## Pre-Development Checklist

- [ ] Does this change affect agent system prompts or how agents present themselves?
- [ ] Read ADR 0023 (Agent Identity Decision Framework)
- [ ] Check `identity-loader.ts` for identity resolution logic
- [ ] Verify identity level is appropriate for the agent path being changed

## Coding Guidelines

### Identity Levels

Four levels control how much identity is injected into system prompts:

| Level | Content | Context Budget | Use Case |
|-------|---------|---------------|----------|
| `none` | Empty string — no identity injected | 0 tokens | Self-check judge (must be objective) |
| `minimal` | `"You are [role]."` — one line | ~5 tokens | Child agents, pre-execution phases |
| `standard` | Multi-block: name, role, style, values, boundaries, heartbeat | ~50-80 tokens | Gateway chat, scheduler executor tasks |
| `full` | Standard + backstory narrative | ~150+ tokens | Future: long-running agent personas |

### Resolution Chain

```
project (.los/identity/<name>/)  → highest priority
  user (~/.los/identity/<name>/)
    system (/etc/los/identity/<name>/)
      built-in default (hardcoded)  → lowest priority
```

Each layer partially overrides — setting only `style` at project level inherits `name`, `role`, etc. from lower layers.

### Decision Matrix (per ADR 0023)

| Execution Path | Identity Level | Memory Level | Configurable? |
|---|---|---|---|
| Gateway Chat (`/chat`) | Standard | Ephemeral + Procedural | API body + config |
| Child/Spawned (`spawn_agent`) | Minimal | None | Fixed (role label) |
| Remote Executor | Minimal | None (self-managed) | Fixed |
| Scheduler Graph - executor/planner | Standard | Ephemeral + Procedural | Task metadata |
| Scheduler Graph - verifier | None | None | Fixed |
| Self-Check Judge | None | None | Fixed (hardcoded) |
| Pre-Execution Phases | Minimal | None (discovery) / Ephemeral (planning) | Phase-dependent |

### Identity File Format

**IDENTITY.md** — agent identity card:
```markdown
---
name: los
role: Agent Execution Platform Operator
style: direct, evidence-based, precise
signature: "— los"
---
```

**SOUL.md** — agent core values:
```markdown
---
values: [precision, honesty, curiosity, restraint]
temperament: calm, systematic
boundaries:
  - Never execute without operator consent gate
  - Never claim verification without evidence
  - Always admit uncertainty
heartbeat: "Every action leaves an audit trail."
---
```

### Anti-Pattern: AP9 — Hardcoded Agent Identity

**NEVER** add agent name/role/persona inline in system prompt strings.

**ALWAYS** route through `resolveAgentIdentity()` → `formatIdentityForPrompt()`.

Example of what NOT to do:
```typescript
const prompt = "You are los, a precise coding assistant. You have access to tools...";
```

Example of what TO do:
```typescript
const identity = resolveAgentIdentity('default', workspaceRoot);
const prompt = formatIdentityForPrompt(identity, 'standard') + '\n\n' + basePrompt;
```

### Environment Variables

```bash
AGENT_IDENTITY_NAME=default     # Agent name for identity resolution
AGENT_IDENTITY_LEVEL=minimal    # Override identity level
AGENT_SYSTEM_PROMPT="..."       # Custom system prompt (replaces default)
```

## Quality Check

```bash
pnpm check                         # Full type-check
node --import tsx -e "
  const { resolveAgentIdentity, formatIdentityForPrompt } = await import('./packages/agent/src/identity-loader.ts');
  console.assert(resolveAgentIdentity('child', process.cwd()).name === 'los-child');
  console.assert(formatIdentityForPrompt(resolveAgentIdentity('default', process.cwd()), 'none') === '');
  console.log('Identity smoke tests passed');
"
```
