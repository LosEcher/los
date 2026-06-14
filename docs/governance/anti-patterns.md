# LOS Agent Anti-Patterns

These are known failure modes observed in `los` development. Each entry
describes the symptom, consequence, prevention mechanism, and relevant code
locations.

Root `AGENTS.md` keeps a short index. This document is the canonical long-form
reference so the always-loaded entrypoint stays readable.

## AP1: Bypassing transitionExecutionState For State Changes

**Symptom**: Calling `updateTaskRun()`, `updateRunSpecStatus()`, or
`updateToolCallState()` directly for status transitions instead of routing
through `transitionExecutionState()`.

**Consequence**: State changes are not validated against legal transition maps,
no `session_event` is emitted, and no `execution_outbox` row is written. This
undermines B0 enforcement, cross-gateway recovery, and compaction evidence.

**Prevention**: `transitionExecutionState()` in `execution-store.ts:94` is the
single validated path. The low-level APIs are internal and should not be
barrel-exported. Recovery paths such as `tool-call-recovery.ts` are the only
exceptions, and they must emit audit events.

**Code**: `packages/agent/src/execution-store.ts:94`,
`scheduler/tool-call-state-persistence.ts:69`

## AP2: Plan Output Only In Chat Memory, Not Persisted

**Symptom**: Brainstorming or planning results exist only in the conversation
history, never written to `run_contract_json`.

**Consequence**: When the session ends or context is compacted, the plan is
lost. The next session starts without the spec context that was agreed upon.

**Prevention**: All plan artifacts must be persisted to
`run_specs.run_contract_json` via `approveRunSpecPhase()` or
`reviseRunSpecPlan()`. The B0 scheduler gate enforces `canStartExecution()` so
the phase must be `plan_approved`.

**Code**: `packages/agent/src/run-contract.ts:130`,
`scheduled-task-runner.ts:113`

## AP3: Marking Task Succeeded Before Verification Completes

**Symptom**: `task_runs.status = 'succeeded'` is set immediately after
`runAgent()` returns, without checking verification records.

**Consequence**: Code is merged without passing required checks. The run_spec
and task_run state machines drift: the run_spec may later be blocked by
verification while the task is already marked succeeded.

**Prevention**: The scheduler's B0 pre-completion gate calls
`checkVerificationGate()` -> `canMarkSucceeded()` before allowing a `succeeded`
transition. All required verifications must be `succeeded` or `skipped`.

**Code**: `packages/agent/src/run-contract.ts:142`,
`scheduled-task-runner.ts:223`

## AP4: Dual State Machine Drift

**Symptom**: `run_spec.status = 'succeeded'` while
`run_contract.phase = 'executing'`. The two independent state machines disagree
about the entity's state.

**Consequence**: Code that checks one surface gets a different answer than code
checking the other. Recovery and replay logic produce inconsistent results.

**Prevention**: `validatePhaseStatusConsistency()` in `run-contract.ts:174`
detects drift and logs warnings. The execution-store calls it after every
`run_spec` transition. Fix drift at the source by updating both surfaces
consistently.

**Code**: `packages/agent/src/run-contract.ts:174`, `execution-store.ts:148`

## AP5: Spec Updated But Agent Not Re-Reading It

**Symptom**: `.los/spec/` or ADR is updated, but the agent session continues
with the old spec loaded at session start.

**Consequence**: Agent follows outdated conventions. New rules are ignored
until the next session.

**Prevention**: Use `loadSpecsForFiles()` at the start of each task phase to
reload relevant specs. The spec-loader deduplicates and returns fresh content
each call. Do not cache spec content across phases.

**Code**: `packages/agent/src/spec-loader.ts`

## AP6: Child Agent Not Inheriting Run Contract

**Symptom**: `spawn_agent` or executor node creates a child agent without
passing the parent's `runContract`.

**Consequence**: Child agents have no phase constraints. They can execute
without an approved plan and succeed without verification. The Fleet Loop
invariant is broken.

**Prevention**: Phase D cross-process propagation. Until implemented, document
that child agents are unconstrained and treat their output as unverified.

**Code**: `packages/agent/src/tools/agent-tools.ts:83`, Phase D roadmap

## AP7: Delaying Quality Check To The End

**Symptom**: Running lint, type-check, or tests only in Phase 3 (Finish)
instead of after each implementation change.

**Consequence**: Bugs compound. A type error introduced in the first change
cascades into multiple files before being caught. Fix cost is higher.

**Prevention**: Run `pnpm check` after every meaningful code change. The
Trellis-style verify-after-implement pattern applies: verify after each
implementation step, not only at finish. CI enforces this but local iteration
should too.

**Code**: `pnpm check` (type-check + lint + structure), `pnpm test`

## AP8: Hardcoded Defaults Diverging From Config Schema

**Symptom**: A default value appears in both `config.ts` (Zod schema) and
`db.ts` (fallback) with different values, or `.env` uses a different port than
the code default.

**Consequence**: Debugging confusion because the effective value depends on
which code path is taken. Onboarding friction because new developers see one
port in docs and another at runtime.

**Prevention**: Keep a single source of truth for each default. The Zod schema
default is the authority. Fallback values in other modules must match or be
removed. Document any intentional differences.

**Code**: `packages/infra/src/config.ts:31`, `db.ts:28`, `.env:1`
