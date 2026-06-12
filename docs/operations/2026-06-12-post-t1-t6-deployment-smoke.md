# 2026-06-12 Post-T1-T6 Deployment Smoke

Date: 2026-06-12 12:54 CST
Trigger: T1-T6 changes deployed via restart (gateway pid=29250, executor pid=29146)

## Pre-Flight

| Check | Result |
|-------|--------|
| `pnpm doctor` | ✅ db=PG, 5 providers, executor enabled |
| `pnpm build` | ✅ 7 tasks, 3 cached |
| `pnpm run restart` | ✅ gateway + executor restarted cleanly |
| Health `GET /health` | ✅ `{"status":"ok","ready":true,"blockers":[]}` |
| `pnpm check` | ✅ contract check passed (8 files) |
| `pnpm test` | ✅ 283 tests, 0 failures |
| CI gate (PR #2) | ✅ passed |

## T1 Smoke: State Transition API

### approve endpoint
- **planning → plan_approved**: ✅ `{"phase":"plan_approved","previousPhase":"planning","phaseChangedAt":"..."}`
- **Duplicate approve rejected**: ✅ `{"error":"approval_failed","message":"Illegal phase transition: 'plan_approved' → 'plan_approved'"}`

### revise-plan endpoint
- **Revision increment**: ✅ `{"planRevision":2,"previousRevision":1,"phase":"planning","previousPhase":"executing"}`

### State projection
- **`GET /runs/:id/state`**: ✅ `{"action":"none","blockers":[],"taskRuns":{"total":1,"succeeded":1}}`

### Run spec lifecycle
- **SSE `/chat` → run spec created**: ✅ Agent ran with phase=executing (B0 gate allowed)
- **`GET /runs/:id`**: ✅ run spec queryable
- **`GET /runs`**: ✅ 44 runs listed

## T1 Verification: Drift Detection

Gateway log confirms `validatePhaseStatusConsistency` is active:
```
WARN [execution-store] Phase/status drift on run_spec ...:
  run_spec.status is 'succeeded' but run_contract.phase is 'executing'
```

This is expected — the SSE chat agent ran with `phase=executing` and the run
spec status transitioned to `succeeded` without the phase advancing through
`verifying`. The drift warning is informational (does not block), consistent
with the design intent in `run-contract.ts:174-202`.

## T5 Smoke: Phase Tool Gate

Phase tool gate (`phase-tool-gate.ts`) is integrated into `loop.ts` tool dispatch.
No production traffic was run through different phases during this smoke. The
code compiles cleanly and the loop integration uses `applyPhaseGate()` which
defaults to `allowed: true` when no phase is set (backward compatible).

## T6 Smoke: Lifecycle Hooks

Lifecycle hook runner is integrated into `scheduled-task-runner.ts` at
`afterStart` and `afterFinish`. Hook execution is fire-and-forget with 30s
timeout. No hooks were configured during this smoke — the default behavior
is a no-op (hooks field absent from run contract).

## Residual Risks

| Risk | Mitigation |
|------|-----------|
| Phase tool gate not exercised with non-executing phases | Gate defaults to `allowed: true` when no phase set; no production impact |
| Lifecycle hooks not tested with actual hook scripts | Hooks field absent by default; non-blocking execution |
| Phase/status drift on agent-completed runs | Warning-only by design; Phase D will add auto-advance |

## Decision

**✅ Deployment accepted.** All state transition API routes function correctly,
drift detection is active, and no errors were introduced. The three residual
risks are non-blocking and tracked as Phase D work.
