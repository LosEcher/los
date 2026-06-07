# Planner Executor Verifier DAG Contract

## Background

The current `los` runtime now has stronger evidence surfaces for run contracts,
run specs, tool call state, verification records, provider compatibility
evidence, eval backlog checks, and redacted external summaries. That makes a
planner/executor/verifier split easier to reason about, but it does not yet
mean a full runtime graph engine exists.

ADR 0012 keeps DAG scheduling in Phase 5. The current Phase 5 minimum is a
durable graph store with `agent_tasks`, `task_edges`, `task_attempts`, ready
task claiming, failed dependency blocking, and attempt evidence links. A full
runtime graph engine remains a later promotion step.

## Contract

A future planner/executor/verifier DAG should be treated as a graph of durable
tasks, not as peer chat between agents.

Required node roles:

1. `planner`: produces bounded task specs and dependency edges.
2. `executor`: performs one bounded task with a run contract and records tool
   state.
3. `verifier`: checks declared evidence and can block final completion.

Required graph state:

1. graph id and parent run spec id;
2. task id, role, status, priority, and attempt count;
3. dependency edges;
4. task attempt start/end time, provider/model, node id, and error class;
5. linked tool call states;
6. linked verification records;
7. final completion decision.

## Completion Rules

1. A task with unmet dependencies cannot start.
2. Independent executor tasks may run in parallel only when their editable
   surfaces do not overlap.
3. A failed dependency blocks downstream work until retry or operator action.
4. A verifier node must reference `verification_records` and can block graph
   completion.
5. External tool summaries may inform planning, but cannot replace `los`
   runtime evidence.
6. Provider/model selection must read provider compatibility evidence without
   confusing readiness with compatibility.

## Stop Conditions

Stop before runtime implementation when any of these are true:

1. tool state cannot be linked to a graph task.
2. verification records cannot block completion.
3. task ownership or editable surfaces are unclear.
4. a graph would need raw external transcript data.
5. graph completion would rely on peer-chat output instead of durable task
   status, task attempts, tool state, and verification evidence.

## Minimum Tests Before Runtime Promotion

1. two independent tasks can run without dependency interference;
2. a failed dependency blocks downstream work;
3. verifier failure blocks completion;
4. verifier success allows completion;
5. retry creates a new task attempt instead of overwriting prior evidence;
6. external summaries remain `external_summary`, not runtime replay evidence.

## Current Status

This contract now has a minimal store/API implementation in
`packages/agent/src/agent-task-graph.ts`, with focused tests in
`packages/agent/src/agent-task-graph.test.ts`.

The completed scope is durable graph state, dependency-aware ready claims,
failed dependency detection, retry/verifier evidence links, read-only graph
inspection, completion decision reporting, and a conservative scheduler entry
that claims and runs one ready task at a time for a single graph. When that
entry is run with `requireVerifier`, missing verifier success now blocks the
linked `run_specs` row instead of allowing a false succeeded transition.
Verifier tasks claimed by the scheduler now execute the linked run spec's
`verification_records` through the verifier runner, attach the verification
record id to the task attempt, and keep failed required checks in a blocked
completion state.

Remaining runtime promotion work is still separate: parallel execution,
editable-surface conflict checks, cancel/operator-attention recovery transition
commands, and UI read models should be added only after they can preserve the
same evidence boundary.
