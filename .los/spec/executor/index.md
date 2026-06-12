# executor — Go SSH/Sandbox Spec

## Pre-Development Checklist

- [ ] Does this change affect executor node connectivity, sandbox isolation, or NDJSON protocol?
- [ ] Read ADR 0010 (Node Connectivity + Capability Taxonomy) and ADR 0011 (Artifact Transfer)
- [ ] Will this change break the NDJSON wire format between gateway and executor?

## Coding Guidelines

### Node Lifecycle
- `executor-nodes.ts` manages node registration, heartbeat, capabilities
- Nodes declare `capabilities.run_agent` — only capable nodes receive agent tasks
- Heartbeat freshness + `candidate=true` + capabilities must agree before dispatching

### Sandbox Isolation
- Executor runs in SSH sandbox or local process
- `workspaceRoot` is a path boundary, not full isolation — Phase D worktree isolation planned
- No tool may escape sandbox without explicit operator configuration

### NDJSON Protocol
- Gateway ↔ Executor communicate via NDJSON stream
- Each line is a JSON object: `{type, payload}`
- Tool call state transitions streamed as NDJSON events
- Simplified executor streams may skip intermediate approval states (triggers fallback audit in tool-call-state-persistence)

### Key Management
- Executor agent key: `.env` gitignored; random key fallback when env unset
- Never commit executor keys or auth material

## Quality Check

```bash
pnpm --filter @los/executor test   # 1 test (Go binary integration)
pnpm run executor:status            # Check executor health
```
