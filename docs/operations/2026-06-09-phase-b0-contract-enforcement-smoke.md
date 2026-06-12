# Phase B0 — Durable Contract Enforcement Smoke

Date: 2026-06-09

## Summary

Phase state machine and transition enforcement is now wired into the scheduler.
A task run cannot start execution without an approved plan, and cannot succeed
while required verifications are pending or failed.

## Evidence

### 1. Run Contract Types

`run-contract.ts` defines:
- `RunPhase`: 10 lifecycle states (`created → discovering → discovery_ready → planning → plan_approved → executing → verifying → succeeded | blocked | failed`)
- `PHASE_TRANSITIONS`: legal transition map with `validatePhaseTransition()` validator
- `PlanStep`: intended work unit with id, title, description, dependsOnIds, editableSurfaces, completionCriteria
- `VerificationRequirement`: executable check (command/assertion/operator_review) distinct from plan step
- `canStartExecution()`: returns `{ allowed: false, reason }` when phase is not `plan_approved` or `executing`
- `canMarkSucceeded()`: checks verification statuses against required verifications

### 2. Scheduler Enforcement

`scheduled-task-runner.ts`:
- After `task.running`: calls `canStartExecution(runContract)`. If blocked → sets task `status: 'blocked'`, emits `task.blocked`, throws
- Before `task.succeeded`: calls `checkVerificationGate(runSpecId, runContract)` which loads `verification_records` and validates

### 3. New Types Added

| Type | Location | Purpose |
|------|----------|---------|
| `RunPhase` | `run-contract.ts` | 10-state lifecycle enum |
| `PlanStep` | `run-contract.ts` | Intended work unit (≠ verification command) |
| `VerificationRequirement` | `run-contract.ts` | Executable check with kind: command/assertion/review |
| `TaskRunStatus` includes `'blocked'` | `task-runs.ts` | Blocked task state |
| `ScheduledTaskEventType` includes `'task.blocked'` | `scheduler/types.ts` | Blocked event type |
| `ScheduledAgentTaskResult` includes `{ status: 'blocked' }` | `scheduler/types.ts` | Blocked return type |

### 4. Contract Update

`contracts/run-spec.yaml` now describes `runContract` with `phase`, `plan`, `verifications` fields.

### 5. ADR Update

ADR 0012 Phase 4 status updated to "partially implemented" with the above deliverables listed.

## Validation

```bash
pnpm check  # 10/10 successful, 0 TypeScript errors
pnpm test   # 164 pass, 0 fail
```

## Remaining for Phase 4 (future work)

- Cross-process phase propagation to child agents and executor nodes
- Active execution resume (attempt/retry contract)
- Phase latency and rejection metrics

## Since This Smoke (2026-06-10)

Plan revision lineage (`reviseRunSpecPlan`, `planRevision`, `planParentRunSpecId`)
and operator approval events (`approveRunSpecPhase`, `run.plan_approved`) are
now implemented. See ADR 0021 for the full current-state declaration.

## Non-Goals

- Did not add pre-execution model turns (DISCOVERY/PLANNING in loop.ts) — that's Phase B1
- Did not add operator approval UI — verification `operator_review` kind exists but routing is deferred
- Did not add automatic plan-step-to-verification-record mapping — plan steps and verification requirements are separate types
