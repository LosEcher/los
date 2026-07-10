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
| `phase` | `RunPhase` (11 values) | Validated against enum |
| `previousPhase` | `RunPhase` | Validated against enum |
| `phaseChangedAt` | `string` (ISO-8601) | Pass-through |
| `plan` | `PlanStep[]` | Normalized with fallback ids |
| `verifications` | `VerificationRequirement[]` | Kind-guarded (command/assertion/operator_review) |
| `planRevision` | `number` | Integer >=1 |
| `planParentRevision` | `number` | Previous revision number within the same run spec |
| `planHistory` | `PlanRevisionSnapshot[]` | Immutable snapshots of superseded plans and verification mappings |
| `planParentRunSpecId` | `string` | Reserved for lineage across distinct run specs |

**Key functions exported:**

| Function | Purpose |
|----------|---------|
| `normalizeRunContractMetadata(input)` | Parse + validate unknown → typed contract |
| `mergeRunContractMetadata(metadata, runContract)` | Store contract under `metadata.runContract` |
| `readRunContractMetadata(metadata)` | Extract contract from metadata bag |
| `validatePhaseTransition(from, to)` | Reject illegal transitions; block terminal-phase mutation |
| `canStartExecution(contract)` | Gate: phase must be `plan_approved` or `executing` |
| `canMarkSucceeded(contract, verificationStatuses)` | Gate: all required verifications must succeed or be explicitly allowlisted as skipped |

**Evidence**:
- Test: `packages/agent/src/run-contract.test.ts` (E14 empty-contract, E15 tool-recovery types, E16 verification shapes)
- Test: `packages/agent/src/run-specs.test.ts` (create/load round-trip)
- Test: `packages/agent/src/task-runs.test.ts` (CRUD with runContract)
- Test: `packages/agent/src/todos.test.ts` (todo metadata round-trip)
- Test: `packages/agent/src/verification-records.test.ts` (runContract seed)

### 2. Phase State Machine

**Source**: `packages/agent/src/run-contract.ts`

11-state lifecycle with validated transition map:

```
created → discovering → discovery_ready
       → planning    → plan_approved
       → executing   → verifying
       → succeeded | blocked | failed | cancelled
```

Legal transitions are enforced by `PHASE_TRANSITIONS`. Terminal phases
(`succeeded`, `failed`, `cancelled`) reject all further transitions. `blocked`
can transition back to `verifying`, `failed`, or `cancelled`. A run-spec status
transition to `succeeded` is rejected unless the contract phase is already
`verifying`.

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
loads current-revision `verification_records` and validates via
`canMarkSucceeded()`. Completion is blocked when required verifications are
pending, failed, or skipped without an explicit `allowedSkippedChecks` entry.
The run spec must also transition to `verifying` before its status may become
`succeeded`.

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
3. Requires a normalized structured plan plus verification mapping for standard/heavyweight execution
4. Persists the plan before setting `phase: plan_approved`
5. Atomically records `run.plan_approved` in `session_events` and `execution_outbox`

**Evidence**:
- Test: `packages/agent/src/run-specs.test.ts` (approval, validation, concurrency, persistence)
- Test: `packages/gateway/src/routes/run-routes.test.ts` (approve route success and errors)
- Test: `packages/agent/src/scheduler.test.ts` (live phase enforcement)

### 5. Plan Revision

**Source**: `packages/agent/src/run-specs.ts` (`reviseRunSpecPlan`)

API: `POST /runs/:id/revise-plan`
CLI: `los run revise-plan <id> --plan '[...]' --reason "..."`

Behavior:
1. Loads current run spec
2. Increments `planRevision` (starts at 1)
3. Appends the superseded plan and verification mapping to immutable `planHistory`
4. Sets `planParentRevision` to the previous revision; it does not self-reference `planParentRunSpecId`
5. Marks prior verification records non-required and creates revision-scoped replacements
6. Resets phase to `planning`
7. Atomically records `run.plan_revised` in `session_events` and `execution_outbox`

**Evidence**:
- Test: `packages/agent/src/run-specs.test.ts` (revision increment, lineage, phase guards)
- Test: `packages/gateway/src/routes/run-routes.test.ts` (revise route success and errors)
- CLI surface is wired (`los run revise-plan`); no CLI end-to-end test exists yet

### 6. Plan Steps & Verification Requirements

**Source**: `packages/agent/src/run-contract.ts`

`PlanStep`: intended work unit (id, title, description, dependsOnIds,
editableSurfaces, completionCriteria). Not every plan step is an executable
verification command.

`VerificationRequirement`: required evidence with three kinds:
- `command` — shell command with stdout/exit-code validation
- `assertion` — structured condition, never interpreted as a shell command
- `operator_review` — human approval shape with reviewer field, never auto-executed

Plan steps and verification requirements are intentionally separate types.
No automatic step-to-verification mapping exists yet. Verification records
persist `kind`, `assertion`, `reviewer`, and `plan_revision`; record ids include
the revision (`verification-<run>-r<revision>-<index>`). Until an authenticated
completion/rejection surface exists, plan approval rejects `assertion` and
`operator_review` requirements instead of approving a permanently blocked run.

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
- planRevision, planParentRevision, planHistory, planParentRunSpecId

## Gaps — Capabilities Without Test or Smoke Evidence

| Capability | Unit Test | Gateway Test | Smoke |
|------------|-----------|-------------|-------|
| `approveRunSpecPhase()` | Direct approval and concurrency tests | Route integration test | Confirmed implemented in runtime |
| `reviseRunSpecPlan()` | Direct revision and lineage tests | Route integration test | Confirmed implemented in runtime |
| `POST /runs/:id/approve` | N/A | Success and error cases | Confirmed implemented in runtime |
| `POST /runs/:id/revise-plan` | N/A | Success and error cases | Confirmed implemented in runtime |
| Phase state machine (`validatePhaseTransition`) | Via canStartExecution only | None | B0 smoke (indirect) |
| `canMarkSucceeded()` | Direct contract and scheduler tests | Direct completion tests | B0 smoke (indirect) |
| Same-run plan revision lineage | Direct revision tests | Revise route test | None |
| Verification `operator_review` completion routing | Approval rejects unsupported kind | None | None |
| Basic run contract propagation to child/executor runs | `registry.test.ts`, `scheduler.test.ts` | N/A | Confirmed for `spawn_agent` child config and executor request config |

## Gaps — Design Intent Not Yet Implemented

These are roadmap items, not drift:

1. Durable child run-spec lineage and child attempt linkage
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
