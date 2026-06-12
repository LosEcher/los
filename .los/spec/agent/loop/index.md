# agent/loop — ReAct Loop Spec

## Pre-Development Checklist

- [ ] Does the change affect the main agent loop (`loop.ts`), scheduler, or task runner?
- [ ] Is this a phase-aware change? Check `run-contract.ts` `RunPhase` before modifying loop behavior
- [ ] Will child agents (`spawn_agent`) inherit this behavior?

## Coding Guidelines

### State Transitions
- **All state changes MUST go through `transitionExecutionState()`** — never call `updateTaskRun`, `updateRunSpecStatus`, or `updateToolCallState` directly for status changes
- Recovery paths (tool-call-recovery, recovery-follow-up) are the only exceptions — must emit audit events
- Phase transitions validated by `PHASE_TRANSITIONS` map in `run-contract.ts`

### B0 Enforcement
- Scheduler MUST call `canStartExecution()` before running agent
- Scheduler MUST call `canMarkSucceeded()` / `checkVerificationGate()` before marking task succeeded
- Bypass of either gate is an architectural invariant violation

### Session Events
- Every state transition emits a `session_event` + `execution_outbox` row (atomic via `transitionExecutionState`)
- Event types follow pattern: `{entity}.{state}` (e.g., `task_run.succeeded`, `tool_call_state.running`)

### Loop Boundaries
- `loop.ts` (~595 lines) is near the 600-line CI gate — split before adding new phases
- Tool policy is enforced by `registry-policy.ts`, not inline in the loop

## Quality Check

```bash
pnpm --filter @los/agent test    # 186 tests — focused harness for state transitions
pnpm check                         # Full type-check + lint + structure
```
