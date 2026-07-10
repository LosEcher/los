# ADR 0025: Conversation and Run Coordinator Boundary

## Status

Proposed (2026-07-10).

## Context

LOS already has most of the persisted objects needed for a project task control
plane:

- `sessions` and `session_events` record interaction and runtime evidence;
- `todos` record planned work;
- `run_specs` record approved execution contracts;
- `task_runs`, tool call states, and verification records record attempts and
  completion evidence;
- the runtime evidence graph and run-state projection expose next actions and
  blockers;
- memory compaction and procedural candidates provide an operator-gated path
  from session evidence to reusable rules.

The missing structure is coordination across these objects. The current
`ga-loop-runner.ts` is a periodic governance job runner. It audits a configured
job, applies bounded fixes, verifies the result, retries, and escalates. It is
not the owner of interactive conversations, project routing, or all execution
state.

Expanding that GA loop into a general agent that owns conversation, tasks,
execution, and memory would create a second state model inside one long-running
agent context. It would also make recovery depend on transcript summaries
instead of the persisted execution ledger.

## Decision

LOS will add a lightweight **conversation coordinator** at the user entrypoint
and a **run coordinator** for persisted task execution. They may initially be
implemented in one module, but their responsibilities remain distinct from the
existing GA governance loop and from bounded workers.

The coordinator is a composition layer over current LOS records. The first
implementation does not introduce a coordinator-owned state table.

### 1. Intake Contract

Every coordinated project request resolves an intake record before execution:

```text
requestId
ownerRepo
taskType
goal
editableSurfaces
nonGoals
riskClass
requestedProvider
requestedModel
toolMode
verification
stopConditions
```

The intake result must distinguish user input, configured defaults, and
coordinator decisions. Unknown ownership or missing verification is a blocker,
not permission to infer a broad write scope.

### 2. Coordinator Responsibilities

The coordinator may:

1. resolve the owner repository, task type, risk class, and expected artifact;
2. load the owner repo's `AGENTS.md`, relevant specs, ADRs, code, and approved
   memory;
3. create or link the session, todo, run spec, and task run;
4. select a bounded worker, provider/model, and tool policy;
5. persist the selection reason and the identifiers required for recovery;
6. project task, event, artifact, verification, and PR evidence to the user;
7. resume from persisted state after interruption or gateway failover.

The coordinator must not:

1. copy all repository rules into a global system prompt;
2. treat a transcript, todo, or worker completion message as execution truth;
3. bypass `transitionExecutionState()`, plan persistence, or
   `canMarkSucceeded()`;
4. execute every task itself instead of dispatching bounded workers;
5. promote conversation content directly into project or global memory;
6. enable heuristic model tiering without an accepted routing contract and
   scenario evidence.

### 3. State Ownership

| Concern | Source of truth | Coordinator use |
| --- | --- | --- |
| Conversation history | `sessions` | Render and resume user interaction |
| Runtime evidence | `session_events` | Read cursor, decisions, failures, and handoffs |
| Planned work | `todos` | Link intent and dependencies; never prove completion |
| Execution contract | `run_specs` | Read scope, plan, verification, and stop conditions |
| Execution attempt | `task_runs` | Observe worker state, lease, provider/model, and result |
| Tool execution | tool call states | Recover or cancel incomplete tool work |
| Completion gate | verification records | Decide whether success is permitted |
| Reusable knowledge | approved memory and rules | Retrieve bounded context; never absorb raw state |

The coordinator stores references and decision metadata in these records. It
does not hold authoritative project state in prompt memory.

### 4. Routing Evidence

Provider and model selection must preserve requested and effective values plus
a structured reason. The currently implemented reasons are:

- `configured_default`
- `explicit_provider`
- `explicit_model`
- `architect_editor_override`

Future reasons such as `risk_escalation`, `quality_escalation`, and `fallback`
require their own policy contract, event evidence, and eval coverage before
they are added. Their names in a design document do not authorize automatic
routing.

Coordinator decisions should become structured session or run events. The
initial event set should cover:

- intake resolved or blocked;
- owner repo and context policy selected;
- worker/provider/model/tool policy selected;
- resume plan selected from persisted state;
- handoff or operator attention requested.

Event payloads must contain identifiers and bounded decision facts, not raw
transcripts, credentials, or copied repository documents.

### 5. Resume Order

On resume, the coordinator reads state in this order:

1. `run_specs` for contract, phase, scope, and verification requirements;
2. run-state projection for the current action and blockers;
3. active and recent `task_runs` for in-flight attempts and leases;
4. `session_events` after the last persisted cursor;
5. incomplete tool states and verification records;
6. the session transcript only for conversation continuity;
7. approved memory only when it is relevant to the owner repo and task type.

This order prevents a recent assistant message from overriding a failed gate,
blocked run, or unverified result. Resume creates a new attempt when the current
state machine requires one; it does not silently mutate a historical attempt.

### 6. GA Governance Loop Boundary

`ga-loop-runner.ts` retains its current meaning: periodic governance jobs with
audit, bounded repair, verification, retry, circuit breaker, and escalation.

The coordinator may create or route work to governance jobs, and governance
jobs may emit findings that appear in a coordinated run. Neither component
owns the other's lifecycle:

- GA governance jobs remain cadence- and job-type-driven;
- conversation coordination remains request- and session-driven;
- run coordination remains contract- and state-driven;
- bounded workers remain execution-driven.

The name "general agent" is therefore not used as a shared implementation
abstraction for these paths.

### 7. Memory Boundary

The coordinator retrieves approved memory but only proposes promotion
candidates. ADR 0020 remains authoritative for evidence thresholds, conflict
review, operator approval, activation, retirement, and source linkage.

A future promotion candidate contract must include at least owner, scope,
source record IDs, evidence count, conflicts, expiry or review date, and review
status. Raw session transcripts and volatile branch or CI state are not durable
memory.

### 8. External Agent Tools

Hermes, Codex, Claude Code, or other agent runtimes may act as entrypoints or
bounded workers when an adapter can preserve LOS identifiers, tool policy, and
evidence. They do not become an alternate source of truth for task state or
memory. External summaries remain subject to ADR 0019.

## Implementation Sequence

### Phase 0: Decision and Scenario Set

1. Accept this ADR.
2. Define 8-12 versioned scenarios covering owner routing, PRD generation,
   read-only review, small code changes, state-machine changes, auth changes,
   process-diagram input, prototype input, resume, and blocked work.
3. Record baseline pass rate, human correction, cost, and repeated work for the
   current direct `/chat` path.

### Phase 1: Intake and Explicit Routing

1. Add the intake schema contract.
2. Implement a deterministic owner resolver before any model fallback.
3. Persist coordinator decisions as events linked to session and run spec.
4. Support explicit Flash/Pro selection while automatic tiering remains off.

### Phase 2: Recovery and Artifact Projection

1. Build a coordinator resume projection from existing run state, event cursor,
   active tasks, tool states, blockers, and verification records.
2. Register PRD, draw.io, prototype, test report, and PR artifacts with owner,
   checksum, and run linkage.
3. Add a bounded read-only reviewer lane over acceptance criteria, diff,
   artifacts, and test evidence.

### Phase 3: Evidence-Gated Automation

1. Permit automatic model selection only after scenario thresholds are met.
2. Permit project procedural memory promotion only through ADR 0020 gates.
3. Add external or local providers only through the existing provider adapter
   and compatibility evidence model.

## Failure Handling

- Unknown owner repo: block intake or route to a bounded cross-project
  investigation; do not default to `aidebug` as the permanent owner.
- Missing or conflicting repo rules: request operator attention before writes.
- Active task with a live lease: wait or steer; do not dispatch a duplicate.
- Stale lease or incomplete tool state: use existing recovery recommendations
  and record the selected action.
- Failed verification: keep the run blocked or failed; do not infer success from
  the worker response.
- Unavailable provider: emit failure evidence; fallback requires an explicit
  policy and route reason.
- Memory conflict: keep the candidate in review and exclude it from runtime
  context.

## Consequences

### Positive

- LOS can become a consistent project-task entrypoint without centralizing all
  state in one agent.
- Existing persisted objects and recovery projections remain authoritative.
- Model, memory, and external-worker automation can be evaluated independently.
- `aidebug` remains a bounded cross-project investigation workspace instead of
  becoming a second task tracker.

### Negative

- Coordination adds more explicit contracts and events before user-visible
  automation increases.
- Deterministic owner routing and artifact ownership require maintained project
  metadata.
- Existing `/chat` behavior will coexist with the coordinator during migration.

## Non-Goals

1. Replacing the provider loop with Hermes or another agent framework.
2. Training or fine-tuning a dedicated model for task intake, PRDs, diagrams,
   or prototypes in the first implementation.
3. Enabling `model-tiering.ts` from this ADR.
4. Creating automatic global memory from conversations.
5. Moving project-specific runbooks, TODOs, or release gates into `aidebug`.

## Verification

Before implementation is called complete:

1. intake schema first-pass validity and owner routing accuracy are measured;
2. every coordinator decision is replayable from persisted records;
3. resume tests prove no duplicate task or tool execution across interruption;
4. success remains blocked until verification records pass;
5. Flash/Pro scenarios report pass rate, cost, and human correction separately;
6. memory candidates cannot become active without ADR 0020 approval evidence;
7. focused tests, contract checks, and `pnpm gate` pass for runtime changes.

## Related Decisions

- ADR 0002: session ledger and observability
- ADR 0007: provider loop and model profiles
- ADR 0012: service cluster and stateful agent roadmap
- ADR 0015: transcript truncation and run replay
- ADR 0019: external summary ingestion
- ADR 0020: memory compaction and procedural learning
- ADR 0021: Stage B operator contract
- ADR 0023: agent identity decision framework

