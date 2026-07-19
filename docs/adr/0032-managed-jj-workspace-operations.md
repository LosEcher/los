# ADR 0032: Managed jj Workspace Operations

- Status: Accepted
- Date: 2026-07-18

## Background

LOS already has a durable planner/executor/verifier task graph, task leases,
editable-surface conflict checks, verification gates, project bindings, and an
artifact store. It does not have a supported user operation that gives graph
tasks isolated working directories or preserves workspace changes before
cleanup. Research notes describe worktree isolation and portable handoff, but
those documents are design evidence rather than current runtime behavior.

The repository itself is jj-managed. Adding a second Git-first lifecycle would
conflict with the project VCS rule and would create two cleanup semantics.

## Decision

LOS will provide a bounded managed-workspace operation surface defined by
`contracts/managed-workspace.yaml`.

Version 0.1.0 uses `jj workspace` only. An operator selects queued executor
tasks from an existing agent graph. LOS creates one sibling managed directory
per selected task from `@-`, records it in PostgreSQL, and writes the managed
workspace id and path into the task metadata. The scheduler uses that path only
for the assigned task.

All mutations require the existing validated operator gate. Release requires
an exact workspace-id confirmation and first stores `jj diff --git` through the
existing artifact store. The database row records the backup artifact id,
release state, actor, and failure details. A filesystem directory or a CLI
summary is not completion evidence by itself.

## Boundaries

This version does not:

1. create a second task-graph or run-state model;
2. automatically merge isolated changes;
3. resolve workspace conflicts;
4. move workspaces between hosts;
5. expose unrestricted paths supplied by clients;
6. remove unregistered directories.

The source root comes from an existing project binding. The managed root is a
server-derived sibling `.los-managed-workspaces` directory. The release path
must still be inside that root before any directory removal occurs.

## Runtime Placement

- `packages/agent`: managed workspace ledger, jj lifecycle, task assignment,
  artifact backup, and scheduler workspace selection.
- `packages/gateway`: dry-run plan and authenticated operation routes.
- `packages/cli`: user commands that preserve access/operator header
  separation.
- PostgreSQL: workspace/task/backup state.
- Artifact store: immutable backup payload and checksum evidence.

## Verification

Focused tests use temporary jj repositories and fake route/CLI requests. No
test creates, forgets, or removes a workspace under the operator's active
repository. Cross-host handoff and automatic integration remain explicit
follow-up gaps in the harness capability audit.
