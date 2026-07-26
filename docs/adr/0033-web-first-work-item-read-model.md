# ADR 0033: Web-first Work Item Read Model

- Status: Accepted
- Date: 2026-07-19

## Background

LOS already persists user work in `todos`, immutable execution input in
`run_specs`, attempts in `task_runs`, interaction history in `sessions` and
`session_events`, and completion evidence in verification and artifact stores.
The current Web console exposes those records on separate pages. A user must
manually correlate ids before deciding whether to approve, recover, verify, or
review a run.

The Web-first daily-agent design needs a user-facing Work Item and Inbox, but a
second execution state machine would make the existing task, run-contract, and
verification invariants ambiguous.

## Decision

LOS will implement the HTTP surface in `contracts/work-item.yaml` as an
agent-owned read model over existing evidence.

1. `todos` remains the Work Item fact source and retains its existing status
   vocabulary.
2. A new `work_item_runs` table stores only lineage from one Work Item to many
   run specs, task runs, and sessions.
3. Inbox states such as `approval_required`, `recovery_required`,
   `verification_blocked`, and `review_ready` are derived projections. They are
   never written into `todos.status`.
4. `availableActions` is the server-declared capability surface for Work. Web
   may use `attentionState` and `nextAction` to explain state, but renders
   effectful controls only from `availableActions`.
5. Creating a Work Item persists a structured run-contract draft in todo
   metadata. It does not create a run spec, approve a plan, or dispatch a task.
6. Read routes may aggregate execution evidence, but write routes may not
   directly update run-spec, task-run, tool-call, or verification status.
7. Attention records without Work Item lineage remain visible as orphan Inbox
   entries so the daily surface does not hide actionable runtime evidence.
8. P1 extends the projection with full verification records and managed
   workspace evidence. Workspaces are correlated through
   `agent_tasks.run_spec_id`; their backup artifact is durable diff evidence.
9. Operator result review is stored in `todos.metadata_json.resultReview`.
   Accepting a result may move the todo to `done`, but only after the linked run
   is succeeded, required verification is complete, and every reviewable
   managed workspace has a backup artifact. It never changes execution state.
10. Verification coverage is a derived project/mode query. Coverage reports
   succeeded and explicitly allowed skips separately from failed, pending, and
   missing requirements.
11. Plan approval capabilities bind `runSpecId`, `planRevision`, and a hash of
    the complete persisted RunContract. A revised or otherwise changed contract
    makes the capability stale; the gateway returns `409
    approval_capability_stale` and the Web reloads the current projection.

## Ownership

- `packages/agent` owns lineage persistence, projection types, attention
  classification, and deterministic next-action selection.
- `packages/gateway` owns authenticated HTTP validation and response mapping.
- `packages/web` owns the daily Inbox and Work Item interaction model.
- `packages/infra` continues to own PostgreSQL connection and migration
  primitives; it does not own Work Item domain behavior.

The table is introduced by a normal migration under `packages/infra/migrations`
because gateway and executor startup already apply that directory. Store code
stays in `packages/agent`; no new `packages/infra/src` module is required.

## Projection Rules

The first applicable condition wins. Terminal and failed evidence outranks an
older planning phase so the read model never offers approval for a failed run:

1. a failed or blocked attempt produces `recovery_required`;
2. a required verification that is missing, pending, or failed produces
   `verification_blocked`;
3. a persisted planning phase waiting for operator approval produces
   `approval_required`;
4. a queued or running attempt produces `running`;
5. succeeded execution evidence on an unfinished todo produces `review_ready`;
6. an unclassified attention event produces `unknown`;
7. otherwise the projection is `none`.

The exact classification is covered by focused tests. When evidence conflicts,
the response exposes source ids and does not repair persisted state from the
read path.

## Boundaries

This decision does not:

1. replace the run-contract or task-run state machines;
2. make Web UI state authoritative;
3. start execution from Work Item creation;
4. put repeated run history into `todos.metadata_json`;
5. define user schedules, external connector credentials, or browser-owned
   scheduler behavior;
6. automatically approve plans, recover attempts, or accept changes;
7. perform VCS release, push, merge, bookmark deletion, or remote cleanup when
   an operator accepts a Work Item result.

Those capabilities remain later phases in the Web-first design.

## Verification

P0 is complete only when contract validation, focused agent/gateway/Web tests,
the repository check, the cross-package gate, and a desktop/mobile Web smoke
pass. The browser smoke must cover stale capability rejection, projection
reload, successful approval of the current revision, and unavailable-action
hiding. P1 additionally requires verification projection/coverage tests, operator
result-decision gate tests, managed workspace backup enforcement, and the
existing recovery, verification, and managed-workspace harnesses.
