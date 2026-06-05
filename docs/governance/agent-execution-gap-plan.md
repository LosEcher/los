# Agent Execution Gap Plan

## Background

The current `los` changes move the project toward an evidence-first agent
execution surface:

1. `session_events` now has a direct event loader for live push replay.
2. Gateway SSE live updates can fetch the persisted session event before
   pushing it to the Web UI.
3. Provider readiness now separates readiness, credential class, promotion
   state, and setup action.
4. `SKILL.md`, `docs/README.md`, `periodic-analysis.md`, and
   `agent-workflow-roadmap.md` define where runtime truth, governance reports,
   and agent workflow decisions belong.

Those changes improve visibility, but they do not yet make `los` a complete
agent execution harness. The remaining gaps are mostly around explicit run
contracts, resumability, tool-state recovery, external-tool comparison, and
eval feedback.

## Evidence Boundary

Use these as current facts:

1. `los` owns `task_runs`, `session_events`, `executor_nodes`, and
   `service_instances`.
2. `.reasonix/truncated-results/` is external capture and can be truncated.
3. `.omx/logs/` is external capture unless a future ingestion contract promotes
   a subset.
4. Claude Code, Codex, Reasonix, OpenCode, and browser tools can remain
   execution entrypoints or comparison sources, but raw transcripts and auth
   snapshots do not become `los` evidence by default.

The comparison below uses local repo docs and known tool behavior. It should be
refreshed before turning any row into a required runtime dependency.

## Tool Comparison

| Surface | Strong fit | Weakness for `los` | What `los` should absorb |
| --- | --- | --- | --- |
| Codex | codebase execution, sandbox/approval habits, file edits, test loops, review mode, local `jj` closeout | current execution evidence mainly lives outside `los`; tool events need redacted capture before ingestion | mode contracts, permission tiers, diff/test closeout, bounded summaries |
| Claude Code | project entrypoint via `CLAUDE.md`, interactive coding, OAuth-style provider state, strong project-memory conventions | provider readiness can be mistaken for execution compatibility; auth and transcripts are external | project read order, explicit credential class, operator-facing setup steps |
| Reasonix | planning/session/event concepts, receipts versus memory distinction, external framework comparison | large command/web captures have truncation risk; external receipt is not `los` replay evidence | event sidecar idea, receipt/memory split, transcript-size policy |
| OpenCode | useful reference for build/plan dual-agent flow and task-oriented execution | not the current source of truth for this repo | planner/executor split only after run state and verifier state exist |
| OMX | hook bridge for local Codex events and possible external tool summaries | hook coverage does not prove durable ledger fidelity; raw log ingestion needs redaction | summarized tool ledger schema, hook provenance, external-only evidence class |

## Current Gaps

### G1. Run Intent Is Still Implicit

Current state:

1. `/chat` accepts prompt, provider, model, workspace, and tool mode.
2. `/chat` creates a basic `run_specs` row before execution.
3. `task_runs` records attempts and lifecycle.
4. `session_events` records audit events.

Gap:

The current `run_specs` row captures execution parameters, but it does not yet
state the full operator contract before execution: mode, goal, required checks,
stop conditions, verification policy, expected evidence, and commit boundary.

Supplement:

1. Use `run-contract-template.md` as the doc-first source for operator
   contract fields.
2. Add contract metadata to todo/task records first.
3. Reconcile the existing `run_specs` schema and `/chat` input mapping after
   the template stabilizes.

Minimum fields:

```text
run_id
mode                  audit | execution | closeout | governance
goal
workspace_root
provider
model
tool_mode
required_checks_json
allowed_skips_json
stop_conditions_json
evidence_required_json
commit_boundary
created_at
```

### G2. Live Stream Is Not Recovery-Grade

Current state:

1. Gateway can push live session events to the Web UI using PostgreSQL
   notification plus `loadSessionEvent`.
2. `/sessions/:id/events` provides persisted audit events.
3. ADR 0015 states that exact `model.delta` replay is not currently persisted.

Gap:

The UI can be updated live, but an interrupted stream still cannot be resumed
as a first-class run through another gateway with a stable cursor contract.

Supplement:

1. Keep session-event live push as the short-term UI improvement.
2. Add `GET /runs/:id/events?since=...` when `run_specs` exist.
3. Decide whether `model.delta` chunk persistence is needed for replay, or
   whether final response plus tool/runtime events are sufficient.

### G3. Tool Calls Are Events, Not Recoverable State

Current state:

1. The agent loop emits tool lifecycle events.
2. Tool registry enforces read-only/project-write/all policies.
3. Tool retry exists in policy form.
4. `tool_call_states` already has CRUD and schema support.

Gap:

The durable table exists, but the agent loop and scheduler do not yet write tool
state transitions that can drive retry, resume, cancellation, or verifier
decisions.

Supplement:

1. Wire `tool_call_states` into the loop and scheduler.
2. Record requested, approved, denied, running, succeeded, failed, retrying,
   and skipped states.
3. Attach input hash, output summary, duration, attempt, retry policy, and
   approval evidence.

This is the concrete bridge from Codex-style tool discipline to a `los` runtime
that can recover from failures.

### G4. Provider Readiness Still Needs Promotion Evidence

Current state:

1. Discovery classifies providers by configured key, readiness, credential
   class, promotion state, and setup action.
2. `los compat` can run fixed probes.
3. ADR 0017 defines advisory, verified advisory, and required states.

Gap:

Readiness and promotion state are still not backed by a persisted
provider-promotion record. A new run can prove compatibility, but that proof is
not yet queryable as a first-class provider gate history.

Supplement:

1. Add `provider_compat_runs` or project a view from `task_runs` and
   `session_events`.
2. Record target, probe, credential class, taskRunId, sessionId, tool outcome,
   usage, cost if available, and decision.
3. Let `los provider list` show verified advisory only when evidence exists.

### G5. External Tools Are Compared Manually

Current state:

1. `periodic-analysis.md` allows external summaries after redaction and
   provenance review.
2. `agent-workflow-roadmap.md` asks for a toolchain matrix.
3. ADR 0015, 0016, and 0018 prevent raw transcript ingestion by default.

Gap:

There is no structured toolchain matrix that says which tool is used for what,
what evidence it creates, what credentials it depends on, and whether it is
safe to compare or ingest.

Supplement:

1. Maintain `docs/governance/toolchain-matrix.md`.
2. Track each tool's role, model route, permission surface, memory/transcript
   location, evidence quality, when to use it, when not to use it, and ingestion
   status.
3. Treat Reasonix, Claude Code, Codex, OpenCode, and OMX as external-only until
   an ingestion ADR defines schema, redaction, and provenance.

### G6. Verification Is Not a Runtime State

Current state:

1. ADR 0014 defines required checks by change type.
2. `pnpm check`, package tests, compat harnesses, and operation smokes exist.
3. The workflow relies on the operator or agent to report checks.

Gap:

Verification results are not tied to a run state. A run can produce output and
claim checks, but `los` does not yet store verification intent, execution,
result, skipped reason, or verifier ownership as state.

Supplement:

1. Add `verification_requirements` to run specs.
2. Add verifier events or verifier tasks before marking durable work complete.
3. Store skipped checks as explicit records with reason and risk.
4. Later, promote verifier tasks into the DAG scheduler.

### G7. Eval Feedback Is Not Queryable

Current state:

1. `periodic-analysis.md` lists eval candidates.
2. `agent-workflow-roadmap.md` proposes 20-50 narrow personal evals.
3. Tests and operation smokes catch some behavior regressions.

Gap:

There is no eval table or report that connects a run to failure class,
verification status, retry count, user feedback, model cost, and tool errors.

Supplement:

1. Add an eval backlog document first.
2. Then add `run_evals` only after run specs exist.
3. Derive initial evals from recurring failures:
   - config truth treated as runtime truth;
   - provider readiness treated as compatibility;
   - dirty worktree broad formatting;
   - external transcript treated as replay;
   - `jj` state judged through Git detached HEAD;
   - task done state without persisted execution evidence.

## Phased Supplement Plan

### Phase 1: Governance Artifacts

Timeframe: current short-term work.

Deliverables:

1. `agent-execution-gap-plan.md`.
2. `toolchain-matrix.md`.
3. `eval-backlog.md` with 20-50 narrow cases.
4. Run contract template finalized in docs.
5. Todo seed entries with execution order and dependencies.

Validation:

1. `pnpm check` for repo coherence.
2. Source-grounded readback that the docs do not contradict ADR 0012, 0014,
   0015, 0016, 0017, or 0018.

### Phase 2: Run Contract In Metadata

Timeframe: after governance docs stop changing every pass.

Deliverables:

1. Add run contract fields to todo/task metadata.
2. Add CLI/UI affordance for mode, required checks, and stop conditions.
3. Keep runtime schema changes optional until operation smokes prove the
   workflow.

Validation:

1. focused agent/gateway tests;
2. one operation smoke showing a run with explicit contract metadata;
3. no raw external transcript stored.

### Phase 3: Durable Run Specs And Verification State

Timeframe: ADR 0012 Phase 3-4.

Deliverables:

1. Reconcile existing `run_specs` with operator contract fields.
2. Add stream replay read model and cursor contract.
3. Wire existing `tool_call_states` into agent execution.
4. Add verification requirements and skipped-check records.

Validation:

1. stream replay smoke;
2. failed-tool retry smoke;
3. verifier failure blocks completion.

### Phase 4: External Tool Comparison Adapter

Timeframe: after toolchain matrix and eval backlog are stable.

Deliverables:

1. Redacted external summary schema.
2. Optional import path for summarized Codex/Claude/Reasonix/OMX run facts.
3. Provenance fields: tool, version, cwd, source file, capture policy, redaction
   policy.

Validation:

1. import fixture with fake secrets;
2. redaction test;
3. no raw prompt/stdout/stderr/auth persisted.

### Phase 5: Controlled Planner/Executor/Verifier DAG

Timeframe: long-term.

Deliverables:

1. minimal task graph;
2. verifier nodes;
3. provider/model selection based on run contract and compat evidence;
4. eval dashboard or API.

Validation:

1. two independent tasks run in parallel;
2. failed dependency blocks downstream work;
3. verifier task controls final run state;
4. quality metrics compare before and after a runtime change.

## Immediate Next Work

1. Add run contract fields to todo/task metadata.
2. Reconcile the existing `run_specs` implementation with operator contract
   fields and replay requirements.
3. Wire `tool_call_states` into the agent loop and scheduler.
4. Add a small operation smoke for the current live event push path:
   `/chat` -> `session_events` -> PostgreSQL notify -> EventSource update.
5. Decide whether `los provider promote` should remain instructional only or
   gain a persisted provider compatibility decision record.
6. Avoid implementing a Reasonix/Codex CLI fallback until ADR 0018's capability
   gap and ledger parity criteria are met.
