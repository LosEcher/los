# agent/tool — Tool System Spec

## Pre-Development Checklist

- [ ] Is this a new tool or a change to an existing tool's policy?
- [ ] Check `registry-policy.ts` for tool allow/deny rules
- [ ] Check `tool-call-states.ts` for state machine compatibility
- [ ] Will this tool need executor sandbox support?

## Coding Guidelines

### Tool State Machine
- States: `requested → approved/denied → running → succeeded/failed/retrying → skipped`
- All transitions enforced by `TOOL_CALL_STATE_TRANSITIONS` in `execution-transitions.ts`
- Use `transitionExecutionState({entityType: 'tool_call_state', ...})` for state changes

### Tool Policy
- `registry-policy.ts` enforces per-mode tool availability
- Audit mode: read-only tools only
- Execution mode: all declared tools
- Closeout mode: read + verification tools

### File Safety
- `path-safety.ts` enforces workspace boundary
- No tool may write outside `workspaceRoot` without explicit operator approval
- `file-tools.ts`, `edit-tools.ts`, `patch-tools.ts` (~400+ lines each) — split before adding new capabilities

### Tool Recovery
- `tool-call-recovery.ts` handles stuck/failed tool calls
- Recovery decisions: retry, resume, cancel, operator_attention
- All recovery state changes emit audit events

## Quality Check

```bash
pnpm --filter @los/agent test    # Tool-related tests
# Check tool files don't exceed 400 line warning (CI blocks at 600)
```
