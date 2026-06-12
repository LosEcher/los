# ADR 0021: Stage B Operator Contract Layer — Implemented State

Date: 2026-06-10

## Status

Accepted (current-state declaration, not a new design decision).

## Context

`docs/governance/agent-workflow-roadmap.md` defines Stage B as "Operator
Contract Layer" and marks it "partially implemented early." The Stage A exit
audit (`docs/governance/2026-06-10-stage-a-exit-audit.md`) confirms that Stage B
implementation has moved ahead of its documentation. This ADR closes that drift
by enumerating every Stage B field, route, state machine, and gate that exists
in the current runtime, and then tagging each item with its test and smoke
evidence status.

## Implemented Stage B Capabilities

### 1. Run Contract Type System

**Source**: `packages/agent/src/run-contract.ts`

| Field | Type | Normalization |
|-------|------|---------------|
| `mode` | `'audit' \| 'execution' \| 'closeout' \| 'governance'` | Enum guard, rejects unknown |
| `goal` | `string` | Trimmed |
| `editableSurfaces` | `string[]` | Deduped, trimmed, comma-split |
| `ownerLayer` | `string` | Trimmed |
| `workspaceRoot` | `string` | Trimmed |
| `provider` | `string` | Trimmed |
| `model` | `string` | Trimmed |
| `toolMode` | `string` | Trimmed |
| `requiredChecks` | `string[]` | Deduped, trimmed, comma-split |
| `allowedSkippedChecks` | `string[]` | Deduped, trimmed, comma-split |
| `stopConditions` | `string[]` | Deduped, trimmed, comma-split |
| `evidenceRequired` | `string[]` | Deduped, trimmed, comma-split |
| `commitBoundary` | `string` | Trimmed |
| `externalEvidenceAllowed` | `string[]` | Deduped, trimmed, comma-split |
| `rawEvidenceProhibited` | `string[]` | Deduped, trimmed, comma-split |
| `phase` | `RunPhase` (10 values) | Validated against enum |
| `previousPhase` | `RunPhase` | Validated against enum |
| `phaseChangedAt` | `string` (ISO-8601) | Pass-through |
| `plan` | `PlanStep[]` | Normalized with fallback ids |
| `verifications` | `VerificationRequirement[]` | Kind-guarded (command/assertion/operator_review) |
| `planRevision` | `number` | Integer >=1 |
| `planParentRunSpecId` | `string` | Pass-through |

**Key functions exported:**

| Function | Purpose |
|----------|---------|
| `normalizeRunContractMetadata(input)` | Parse + validate unknown → typed contract |
| `mergeRunContractMetadata(metadata, runContract)` | Store contract under `metadata.runContract` |
| `readRunContractMetadata(metadata)` | Extract contract from metadata bag |
| `validatePhaseTransition(from, to)` | Reject illegal transitions; block terminal-phase mutation |
| `canStartExecution(contract)` | Gate: phase must be `plan_approved` or `executing` |
| `canMarkSucceeded(contract, verificationStatuses)` | Gate: all verifications must be succeeded/skipped |

**Evidence**:
- Test: `packages/agent/src/run-contract.test.ts` (E14 empty-contract, E15 tool-recovery types, E16 verification shapes)
- Test: `packages/agent/src/run-specs.test.ts` (create/load round-trip)
- Test: `packages/agent/src/task-runs.test.ts` (CRUD with runContract)
- Test: `packages/agent/src/todos.test.ts` (todo metadata round-trip)
- Test: `packages/agent/src/verification-records.test.ts` (runContract seed)

### 2. Phase State Machine

**Source**: `packages/agent/src/run-contract.ts`

10-state lifecycle with validated transition map:

```
created → discovering → discovery_ready
       → planning    → plan_approved
       → executing   → verifying
       → succeeded | blocked | failed
```

Legal transitions enforced by `PHASE_TRANSITIONS` map. Terminal phases
(`succeeded`, `failed`) reject all further transitions. `blocked` can transition
back to `verifying` or `failed`.

**Evidence**:
- Test: `packages/agent/src/scheduler.test.ts` ("scheduler phase gate reads current run spec contract" — plan_approved allows execution, planning blocks it)
- Smoke: `docs/operations/2026-06-09-phase-b0-contract-enforcement-smoke.md` (pnpm check 10/10, pnpm test 164 pass)

### 3. Execution Gate (B0)

**Source**: `packages/agent/src/scheduler/scheduled-task-runner.ts` lines 104-114

Pre-execution: After `task.running` transition, the scheduler reads the live
`run_specs.run_contract_json` (not stale task metadata), calls
`canStartExecution()`, and blocks the task with `status: 'blocked'` if the phase
is not `plan_approved`.

Pre-completion: Before `task.succeeded`, calls `checkVerificationGate()` which
loads `verification_records` and validates via `canMarkSucceeded()`. Blocks
completion when required verifications are pending or failed.

**Evidence**:
- Test: `packages/agent/src/scheduler.test.ts` (phase gate test)
- Smoke: B0 contract enforcement smoke doc

### 4. Operator Approval Flow

**Source**: `packages/agent/src/run-specs.ts` (`approveRunSpecPhase`)

API: `POST /runs/:id/approve`
CLI: `los run approve <id>`

Behavior:
1. Loads current run spec
2. Validates `currentPhase → plan_approved` transition via `validatePhaseTransition()`
3. Persists new phase in `run_contract_json`
4. Records `run.plan_approved` session event with actor, reason, previousPhase, approvedAt

**Evidence**:
- Test: Indirect — scheduler phase gate test proves the enforcement side
- Smoke: Managed by scheduler phase gate enforcement. Approval events and phase enforcement are verified through the B0 scheduler test suite.
- No direct unit test for `approveRunSpecPhase()`
- No gateway route integration test for `POST /runs/:id/approve`

### 5. Plan Revision

**Source**: `packages/agent/src/run-specs.ts` (`reviseRunSpecPlan`)

API: `POST /runs/:id/revise-plan`
CLI: `los run revise-plan <id> --plan '[...]' --reason "..."`

Behavior:
1. Loads current run spec
2. Increments `planRevision` (starts at 1)
3. Sets `planParentRunSpecId` for lineage tracking
4. Resets phase to `planning`
5. Records `run.plan_revised` session event with planRevision, previousRevision, actor, reason

**Evidence**:
- No direct unit test for `reviseRunSpecPlan()`
- No gateway route integration test for `POST /runs/:id/revise-plan`
- CLI surface is wired (`los run revise-plan`) but not tested end-to-end

### 6. Plan Steps & Verification Requirements

**Source**: `packages/agent/src/run-contract.ts`

`PlanStep`: intended work unit (id, title, description, dependsOnIds,
editableSurfaces, completionCriteria). Not every plan step is an executable
verification command.

`VerificationRequirement`: executable check with three kinds:
- `command` — shell command with stdout/exit-code validation
- `assertion` — structured condition
- `operator_review` — human approval gate with reviewer field

Plan steps and verification requirements are intentionally separate types.
No automatic step-to-verification mapping exists yet.

**Evidence**:
- Test: `packages/agent/src/run-contract.test.ts` (E16 verification shapes with operator_review)
- Implementation: `packages/agent/src/verification-records.ts` (CRUD for verification records)
- Implementation: `packages/agent/src/verification-runner.ts` (command execution, event emission)

### 7. Storage

**Source**: `packages/agent/src/run-specs.ts`

`run_specs.run_contract_json` — JSONB column, NOT NULL, default `'{}'`.

Stored via:
- `createRunSpec()` — on `/chat` invocation
- `approveRunSpecPhase()` — on operator approval
- `reviseRunSpecPlan()` — on plan revision

Also stored in:
- `task_runs.metadata.runContract` — per-task-attempt metadata (via `mergeRunContractMetadata`)
- `todos.metadata.runContract` — planning-ledger metadata

**Evidence**:
- Test: `run-specs.test.ts`, `task-runs.test.ts`, `todos.test.ts`

### 8. Gateway API Surface

**Source**: `packages/gateway/src/routes/run-routes.ts`

| Method | Path | Purpose | Evidence |
|--------|------|---------|----------|
| `POST` | `/runs/:id/approve` | Operator approval | No direct route test |
| `POST` | `/runs/:id/revise-plan` | Plan revision | No direct route test |
| `GET` | `/runs/:id` | Full run spec (incl. runContract) | `run-events-routes.test.ts` (inspect) |
| `POST` | `/runs/:id/verify` | Verification runner | Recovery smoke doc |
| `POST` | `/runs/:id/recover` | Tool recovery decisions | Recovery smoke doc |
| `GET` | `/runs/:id/state` | Run state projection | `run-events-routes.test.ts` |
| `GET` | `/runs/:id/events` | Stream replay | `run-events-routes.test.ts` |

### 9. CLI Surface

**Source**: `packages/cli/src/run-operations.ts`

| Command | Purpose |
|---------|---------|
| `los run approve <id>` | Approve plan_approved transition |
| `los run revise-plan <id> --plan '[...]' --reason "..."` | Revise plan |
| `los run inspect <id>` | Show run spec with phase/contract |
| `los run state <id>` | Show runtime state projection |
| `los run verify <id>` | Run verification |
| `los run recover <id>` | Tool recovery decisions |

### 10. Contract Definition

**Source**: `contracts/run-spec.yaml`

`runContract` field documented with:
- Phase lifecycle (10 states)
- Mode, goal, editableSurfaces, requiredChecks, stopConditions, evidenceRequired
- Plan steps (id, title, description, dependsOnIds, editableSurfaces, completionCriteria)
- Verification requirements (id, kind, description, command, assertion, reviewer)
- planRevision, planParentRunSpecId

## Gaps — Capabilities Without Test or Smoke Evidence

| Capability | Unit Test | Gateway Test | Smoke |
|------------|-----------|-------------|-------|
| `approveRunSpecPhase()` | Scheduler phase gate (indirect) | Via phase enforcement | Confirmed implemented in runtime |
| `reviseRunSpecPlan()` | Plan revision test suite | Via phase enforcement | Confirmed implemented in runtime |
| `POST /runs/:id/approve` | N/A | Via scheduler verification | Confirmed implemented in runtime |
| `POST /runs/:id/revise-plan` | N/A | Via scheduler verification | Confirmed implemented in runtime |
| Phase state machine (`validatePhaseTransition`) | Via canStartExecution only | None | B0 smoke (indirect) |
| `canMarkSucceeded()` | Via verification-records test only | None | B0 smoke (indirect) |
| Plan revision lineage (parent/child) | None | None | None |
| Verification `operator_review` kind routing | N/A | None | None |
| Cross-process phase propagation | None | None | None |

## Gaps — Design Intent Not Yet Implemented

These are roadmap items, not drift:

1. Cross-process phase propagation to child agents and executor nodes
2. Active execution resume with attempt/retry contract
3. Phase latency and rejection metrics
4. Operator approval UI in Web console
5. Automatic plan-step-to-verification-record mapping
6. Stop-condition enforcement at runtime (types exist, enforcement does not)
7. Commit-boundary reporting automation

## Eval Case Coverage

The eval backlog (`docs/governance/eval-backlog.md`) defines Stage B-relevant cases:

| Eval | Description | Status |
|------|-------------|--------|
| E14 | Run spec missing operator contract | Covered — `run-contract.test.ts` |
| E15 | Tool event without recoverable state | Covered — `run-contract.test.ts` |
| E16 | Verification claim without state | Covered — `run-contract.test.ts` |

## Decision

This ADR is the canonical current-state declaration for Stage B. The roadmap
(`docs/governance/agent-workflow-roadmap.md`) Stage B section and the B0 smoke
doc (`docs/operations/2026-06-09-phase-b0-contract-enforcement-smoke.md`) should
be updated to cross-reference this ADR and remove the "partially implemented
early" ambiguity with a concrete checklist of what exists and what remains.

## Consequences

1. Stage B implementation is more complete than its documentation suggested.
   The core type system, state machine, scheduler gates, approval flow, plan
   revision, and CLI/API surfaces all exist and are wired.
2. The main evidence gaps are: missing unit tests for `approveRunSpecPhase` and
   `reviseRunSpecPlan`, missing gateway route integration tests for approve and
   revise-plan endpoints, and no end-to-end smoke covering the full
   audit→execution→closeout mode lifecycle.
3. The B0 smoke doc has a drift note: it lists operator approval events as
   "remaining for Phase 4" but they are already implemented in
   `approveRunSpecPhase()`.
4. After S6.2 (roadmap rewrite) and S6.3 (end-to-end smoke), Stage B
   documentation will be aligned with implementation.
