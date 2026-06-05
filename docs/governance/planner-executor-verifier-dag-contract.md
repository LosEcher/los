# Planner Executor Verifier DAG Contract

## Background

The current `los` runtime now has stronger evidence surfaces for run contracts,
run specs, tool call state, verification records, provider compatibility
evidence, eval backlog checks, and redacted external summaries. That makes a
planner/executor/verifier split easier to reason about, but it does not yet
mean a DAG scheduler exists.

ADR 0012 keeps DAG scheduling in Phase 5. The current blocking dependency is
`todo-los-dag-scheduler`, which still needs durable `agent_tasks`,
`task_edges`, and `task_attempts` before graph execution can be runtime-owned.

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

1. `agent_tasks`, `task_edges`, and `task_attempts` do not exist.
2. tool state cannot be linked to a graph task.
3. verification records cannot block completion.
4. task ownership or editable surfaces are unclear.
5. a graph would need raw external transcript data.

## Minimum Tests Before Runtime Promotion

1. two independent tasks can run without dependency interference;
2. a failed dependency blocks downstream work;
3. verifier failure blocks completion;
4. verifier success allows completion;
5. retry creates a new task attempt instead of overwriting prior evidence;
6. external summaries remain `external_summary`, not runtime replay evidence.

## Current Status

This contract is a design input. Runtime implementation remains blocked by
`todo-los-dag-scheduler`.
