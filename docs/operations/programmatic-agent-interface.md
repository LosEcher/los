# Programmatic Agent Interface

## Supported Path

`los mcp serve` is the supported process interface for external editors and
agents. It speaks MCP over newline-delimited JSON-RPC on stdio and calls the
existing gateway HTTP routes. Start the managed gateway before connecting an
MCP host:

```bash
pnpm start
pnpm run status
./bin/los mcp serve
```

The last command is normally started by the MCP host. Its stdout is reserved
for protocol messages; readiness diagnostics go to stderr.

For a built or installed CLI package, use `los-mcp`. This dedicated binary
loads only the adapter; `bin/los mcp serve` is the source-checkout alias.

For a source checkout, use an absolute command path in host configuration:

```json
{
  "mcpServers": {
    "los": {
      "command": "/absolute/path/to/los/bin/los",
      "args": ["mcp", "serve", "--gateway", "http://127.0.0.1:8080"],
      "env": {
        "LOS_AUTH_TOKEN": "<access-token>",
        "LOS_OPERATOR_TOKEN": "<operator-token>",
        "LOS_MCP_TENANT_ID": "local",
        "LOS_MCP_USER_ID": "editor-agent"
      }
    }
  }
}
```

Do not put credentials in tool arguments or checked-in host configuration.
Use the host's secret/environment mechanism.

## Tools

| Tool | Required input | Gateway surface | Authorization |
| --- | --- | --- | --- |
| `los_run` | `prompt`, `projectId` | `POST /chat` | access token; `operatorScope` and `project-write` also require the operator credential |
| `los_runs_list` | `projectId` | `GET /runs` | access token |
| `los_run_state` | `runSpecId`, `projectId` | `GET /runs/:id/state` | access token |
| `los_run_replay` | `runSpecId`, `projectId` | `GET /runs/:id/stream` | access token |
| `los_run_verify` | `runSpecId`, `projectId` | `POST /runs/:id/verify` | access and operator tokens |
| `los_run_approve` | `runSpecId`, `projectId` | `POST /runs/:id/approve` | access and operator tokens |
| `los_run_recover` | `runSpecId`, `projectId` | `POST /runs/:id/recover` | access and operator tokens |
| `los_run_revise_plan` | `runSpecId`, `projectId`, `plan` | `POST /runs/:id/revise-plan` | access and operator tokens |
| `los_task_cancel` | `taskRunId`, `projectId` | `POST /tasks/:id/cancel` | access and operator tokens (the adapter is stricter than the route) |
| `los_operator_control` | `sessionId`, `projectId`, `type` | `POST /sessions/:id/operator-events` | access and operator tokens |

When a run ends `blocked` or `error`, `los_run` also reads the run state and
returns `nextAction` (`action`, `summary`, bounded `blockers`) so the caller knows
which tool to call next — for example `action: "run_verification"` — instead of
only learning that the run stopped. Success terminals skip that extra read, and a
failed read is reported as `nextActionError` rather than swallowing the result.

`los_runs_list` exists because an MCP host can cut a long `los_run` at its tool
timeout, which loses the `runSpecId`. Pass the `traceId` the run was started
with (plus `projectId`) to recover it; `status` and `limit` (default 10, maximum
50) narrow the list. `GET /runs` takes no filters and returns full prompts, so
the adapter filters, sorts newest-first, truncates each prompt to a preview, and
bounds the result itself.

`los_run` returns a bounded terminal projection containing `sessionId`,
`runSpecId`, `taskRunId`, trace/request ids when present, run status, terminal
text, the observed SSE event types, and the resolved `ownerRepo` /
`requestedProjectId` / `workspaceRoot`. Use `los_run_state` for the current
recovery-grade decision and `los_run_replay` for persisted evidence rather
than treating the MCP result text as the task source of truth.

## Detached Dispatch

`los_run` holds the SSE stream until the run reaches a terminal event, which
loses the `runSpecId` when a host cuts the call at its tool timeout. Pass
`detach: true` for long work: the adapter returns as soon as the run identity is
complete (`runSpecId` from the intake event plus `sessionId` and `taskRunId`),
aborts the stream, and reports `status: "detached"` with `detached: true`.

The run keeps executing — measured on 2026-10-11: after an aborted stream the run
and its task both reached `succeeded`, and a detached dispatch returned in ~100 ms
with the run then succeeding on its own. Read it back with `los_run_state`,
`los_run_replay`, or `los_runs_list`. The project-scope guard still runs before a
detached result is reported, so `detach` cannot hide a mis-scoped run.

## Run Lifecycle Control

`los_run_verify` runs the run's persisted required checks and returns a bounded
projection: the completion decision, the record ids that ran, and per-record
`id` / `checkName` / `kind` / `status` / `required` plus an `outputSummary`
truncated to 300 characters. The gateway's own side effects (a work-item
revision on a blocked decision) still happen and are not adapter behaviour.

`los_run_approve` performs the plan-phase approval. Pass `planRevision` and
`contractHash` together or omit both; the adapter rejects a half-supplied pair
before calling the gateway. Both tools require the operator credential, matching
the gateway routes they wrap.

Note the two phase notions this touches: the approval transition reads
`runContract.phase` (so an approved run reports `previousPhase: "planning"`),
while `los_run_state` classifies the run from run/task status and can report
`phase: "created"` for the same run. Read `los_run_state` for lifecycle
grounding and the approve result for the approval transition itself.

## Recovery and Plan Revision

`los_run_recover` reads the tool-call recovery decision and only applies it when
`apply: true` is passed, so the default call is read-only. `intent: "cancel"` with
`apply: true` is **the run-level termination path**: it transitions the run spec to
`cancelled` (verified: `runSpecStatus: "cancelled"`, `eventType:
"run.recovery_cancelled"`, and `los_run_state` then reports `phase: cancelled`).
`los_task_cancel` remains the task-level stop for a live task run.

Both gateway response shapes (preview decision, applied transition) are projected
into one bounded result: every id list is capped at 20 entries with a `truncated`
flag and `reasons` at 10.

`los_run_revise_plan` replaces the persisted plan and returns the new revision
(`planRevision` / `previousRevision` / `phase`). A missing or empty `plan` is
rejected locally instead of silently bumping the revision.

## Cancelling

`los_task_cancel` wraps the task-level route because the gateway has no
run-level cancel. Get the id from `los_run_state`'s `activeTaskRunIds`. The
gateway route is ungated, so the adapter is deliberately stricter and requires
the operator credential before it calls it.

The gateway returns `live: true` with `status: "cancelled"` when it cancelled a
task scheduled on this process, and `live: false` with the task run when a remote
executor holds it (a cancellation request is recorded for that executor). Either
way a queued or running task run transitions to `cancelled`. Note the residual:
cancelling the task does not move the run spec, so `los_run_state` can still
report `phase: "created"` with zero active tasks after a successful cancel.

For steering, pass `type=steering` and `instruction`. For queued continuation,
pass `type=followup` and `prompt`. The gateway derives the operator actor from
the validated operator token; the adapter does not accept an actor override.

## Cross-Project Scoping

`projectId` and `workspaceRoot` take effect only for **operator-scoped** calls.
With `auth.enabled`, the gateway pins a non-operator caller to its configured
default project and treats the requested project as a routing hint, so a
non-operator `los_run(projectId=other)` executes in the default project unless
it is rejected. Pass `operatorScope: true` (which requires the adapter operator
credential and forwards the operator header to `POST /chat`) to target another
bound project; `workspaceRoot` additionally requires operator scope at the
gateway.

Because a mis-scoped run must never look successful, the adapter reads
`coordinator.intake_resolved` from the run stream and returns an MCP error when
the resolved `ownerRepo` differs from the requested `projectId`, quoting both
projects, the resolution reason, and the run identifiers. The failure mode is
therefore a loud error, not a silent run in the wrong repository. The audit and
its evidence are in
`operations/2026-10-11-dsh-los-cross-project-dispatch-audit.md`.

Ordinary reads (`los_run_state`, `los_run_replay`) are tenant-scoped rather
than project-scoped by design, so replay of a run in another bound project
works with the access token alone.

## Safety Boundary

1. `projectId` is explicit on every call and is forwarded as request context.
2. Tenant/user headers come from `LOS_MCP_TENANT_ID` and `LOS_MCP_USER_ID`.
3. Ordinary reads never receive the operator header. `los_run` receives it only
   when the caller sets `operatorScope: true`, which the adapter rejects without
   an operator credential.
4. `project-write` and `operatorScope` are unavailable when the adapter has no
   operator credential.
5. `all` tool mode is not part of the MCP contract.
6. The adapter never writes PostgreSQL or transitions execution state itself.
7. A run whose resolved `ownerRepo` differs from the requested `projectId`
   returns an MCP error with the run identifiers, never a success projection.

## Verification

```bash
./tools/check-contracts.sh
pnpm --filter @los/cli test
pnpm --filter @los/cli check
pnpm --filter @los/cli build
pnpm check
```

A deterministic stdio probe should start `los-mcp`, then send `initialize`,
`notifications/initialized`, and `tools/list` to the built CLI and assert that
the seven contracted tools are present. A live run probe additionally requires
a current provider compatibility decision and may consume provider quota; it
is not implied by the protocol smoke.
