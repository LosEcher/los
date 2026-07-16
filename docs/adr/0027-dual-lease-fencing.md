# ADR 0027: Dual Lease Fencing

## Status

Accepted.

## Context

Graph execution owns two durable records while work is active: `agent_tasks`
tracks the graph claim and `task_runs` tracks the concrete model/tool run. Both
tables already had lease expiry timestamps, but neither had a fencing token.
Heartbeat failures were ignored and terminal writes did not prove that the
writer still owned the claim. A stale worker could therefore finish after a
reaper had reassigned the graph task.

## Decision

1. `claimReadyAgentTasks()` atomically increments `agent_tasks.lease_version`.
2. A graph-created `task_run` inherits that version and starts with the same
   node owner and lease duration.
3. Heartbeats for both records require the expected owner, lease version, and
   an unexpired current lease.
4. The scheduler renews both records together. Failure to renew either record
   aborts the active execution with a lease-loss reason.
5. Terminal `agent_task` and `task_run` transitions use the same fence. A stale
   owner receives a lease-loss error and cannot overwrite the new owner.
6. Recovery may clear the owner and requeue an expired `agent_task`, but it does
   not decrement or reuse a lease version. The next claim increments it again.

`lease_version` is a monotonically increasing fencing token, not a retry count.
Retry policy remains owned by attempts and dead-letter handling.

## Consequences

- Long-running work remains valid while both heartbeats succeed.
- DB loss or ownership drift fails closed by aborting the worker.
- Old workers cannot commit after expiry or reassignment.
- Non-graph scheduled tasks use their task-run lease version independently;
  graph tasks share the agent-task version across both records.

## Verification

- A stale agent-task owner cannot heartbeat or write a terminal status.
- A stale task-run owner cannot heartbeat or transition to a terminal status.
- Two claims of the same recovered task produce increasing lease versions.
- Losing either half of the dual heartbeat aborts a running graph task.
