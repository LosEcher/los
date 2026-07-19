# Managed jj Workspace Operations

LOS can allocate isolated jj workspaces to queued executor tasks that already
exist in an agent task graph. This is an operator operation, not an automatic
merge workflow.

## Preconditions

1. Gateway and PostgreSQL are running.
2. The source repository is bound as a LOS project and is managed by jj.
3. Target tasks have role `executor`, status `queued`, and non-empty
   `metadata.editableSurfaces`.
4. `LOS_AUTH_TOKEN` and `LOS_OPERATOR_TOKEN` are available to the CLI process
   when gateway auth is enabled.

## Plan Without Mutation

```bash
los workspaces plan GRAPH_ID --project PROJECT_ID
```

The plan reports eligible and blocked tasks. Overlapping editable surfaces are
not allocated in the same plan. This command sends only the access credential.

## Allocate Isolated Workspaces

```bash
los workspaces apply GRAPH_ID --project PROJECT_ID
los workspaces apply GRAPH_ID --project PROJECT_ID --tasks TASK_A,TASK_B
```

LOS creates each workspace from `@-` under a server-derived sibling directory:

```text
<source-parent>/.los-managed-workspaces/<project-id>/<workspace-id>
```

The resulting `managed_workspaces` row is assigned to the task through
`agent_tasks.metadata_json`. When the graph scheduler later executes that task,
it uses the assigned workspace root. Other tasks keep their original scheduler
workspace.

## Inspect Evidence

```bash
los workspaces list --graph GRAPH_ID
los workspaces inspect WORKSPACE_ID
```

`inspect` returns the current workspace row and append-only lifecycle events.
The row records source root, task, graph, base revision, status, latest backup
artifact, actor, timestamps, and failure details.

## Back Up Changes

```bash
los workspaces backup WORKSPACE_ID
```

LOS snapshots the workspace through jj, captures `jj diff --git`, and stores it
as a checksummed artifact. A clean workspace produces an empty but still
auditable artifact.

## Release Safely

```bash
los workspaces release WORKSPACE_ID --confirm WORKSPACE_ID
```

Release fails unless the confirmation matches exactly. It creates a fresh
artifact backup, forgets the named jj workspace, removes only the registered
directory under the managed root, clears the task assignment, and records a
`workspace.released` event. A backup or release failure leaves a `failed` row
and event for operator inspection.

## Current Boundaries

Version 0.1.0 does not merge workspace changes, resolve conflicts, create task
graphs, move workspaces between hosts, or transfer an active agent session.
Operators review the artifact/workspace evidence and integrate changes through
the repository's normal jj workflow.
