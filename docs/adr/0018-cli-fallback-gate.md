# ADR 0018: CLI Fallback Gate

Status: Accepted

Date: 2026-06-03

## Background

ADR 0007 allowed a future CLI fallback only as an emergency or comparison path,
not as the default `los` runtime. The 2026-06-02 historical review also raised
legacy `core-loop.mjs` fallback policy as a possible unresolved item.

These are related but not the same problem:

1. legacy `core-loop.mjs` belongs to legacy codebase policy unless current
   `los` runtime dependency is proven;
2. `los` still needs its own gate for any future Reasonix/Codex CLI fallback.

This ADR defines the `los` fallback gate and keeps legacy fallback policy out
of `los` unless an active dependency appears.

## Current Evidence

1. `projects/los` has no current `core-loop.mjs` reference in active source.
2. Workspace search found `core-loop.mjs` only in historical/boundary review
   documents, not in current `los` runtime modules.
3. `packages/agent/src/loop.ts` uses the built-in provider loop and
   `createEventEmitter()` for `session_events`.
4. `packages/agent/src/session-events.ts` is the append-only ledger for
   los-owned run evidence.
5. `packages/agent/src/task-runs.ts` is the task lifecycle ledger.
6. Current child-process execution in active `los` code is limited to existing
   bounded surfaces such as the shell sandbox and executor maintenance runner.
   There is no Reasonix/Codex CLI fallback adapter.
7. `packages/agent/src/todo-seeds.ts` contains
   `todo-los-cli-fallback-gate`, which asks for cwd, permission, budget,
   transcript, exit-code, task/session evidence, and deactivation conditions.

## Decision

`los` will not add a Reasonix/Codex CLI fallback by default.

A CLI fallback may be added only when an ADR or contract proves all of these:

1. **Capability gap**: the built-in provider loop cannot reproduce a required
   behavior through provider/profile/tool changes in the current timeframe.
2. **Explicit trigger**: the fallback is selected by a named runtime policy,
   not by silent provider failure or implicit model routing.
3. **Ledger parity**: fallback execution creates or updates `task_runs` and
   writes compact `session_events` for start, command, tool-equivalent actions,
   completion, failure, and cancellation.
4. **Permission parity**: fallback must enforce the same `toolMode`,
   workspace-root, tenant/project/user, request id, trace id, approval, and
   sandbox boundaries as the built-in loop.
5. **Budget and timeout**: fallback must declare timeout, token/cost budget
   where applicable, retry policy, and cancellation handling before execution.
6. **Artifact policy**: raw transcripts, stdout/stderr, prompts, auth snapshots,
   and copied tool output remain local and git-ignored unless a separate
   redaction contract approves a bounded summary.
7. **Exit strategy**: the fallback has a removal condition. When the built-in
   loop gains the missing capability, the fallback becomes disabled or advisory.

## Non-Goals

1. Do not adopt legacy `core-loop.mjs` as a `los` runtime fallback.
2. Do not wire `los` back to legacy repositories to reuse fallback behavior.
3. Do not treat external agent transcripts as `los` replay or merge-gate truth.
4. Do not bypass `session_events` because an external CLI already has its own
   logs.

## Required Event Shape

A future fallback implementation should emit compact events equivalent to:

```text
fallback.started
fallback.command
fallback.output_summary
fallback.result
fallback.failed
fallback.cancelled
```

Each event must carry the same context fields used by the current event ledger:

```text
sessionId
tenantId
projectId
userId
nodeId
requestId
traceId
turn
source
model or external runtime id
payload summary
```

If fallback output maps to tool behavior, it must also preserve tool name,
tool-call identifier when available, approval decision, result status, duration,
and bounded content length.

## Legacy Boundary Rule

Legacy `core-loop.mjs` policy stays outside `los` unless one of these becomes
true:

1. current `los` code imports, shells out to, or runtime-configures that file;
2. a live `los` operation smoke proves a runtime dependency on that fallback;
3. a future migration ADR explicitly copies a behavior into `los`.

Until then, `core-loop.mjs` remains historical context for the legacy owner,
not a `los` implementation task.

## Implementation Implications

1. `todo-los-cli-fallback-gate` is complete as a gate-definition task after
   this ADR.
2. Implementing a fallback adapter remains a separate future task and requires
   the criteria above.
3. Existing `session_events` and `task_runs` stay the required evidence layer
   for any fallback path.
4. ADR 0015, ADR 0016, and ADR 0017 continue to apply: external transcripts,
   `.omx` logs, and advisory provider evidence do not become merge-gate truth
   without explicit schema and promotion decisions.

## Verification

Evidence used:

1. `rg "core-loop\\.mjs|core-loop|fallback" projects/los`
2. `find projects -name 'core-loop.mjs' -o -name '*core-loop*'`
3. `rg "spawn\\(|execFile|child_process|Reasonix|Codex|fallback" packages/agent/src packages/gateway/src packages/cli/src packages/executor/src`
4. `packages/agent/src/loop.ts`
5. `packages/agent/src/event-emitter.ts`
6. `packages/agent/src/session-events.ts`
7. `packages/agent/src/task-runs.ts`
8. `packages/agent/src/todo-seeds.ts`
