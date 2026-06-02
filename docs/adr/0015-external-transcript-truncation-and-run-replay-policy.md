# ADR 0015: External Transcript Truncation And Run Replay Policy

Status: Accepted

Date: 2026-06-02

## Background

The 2026-06-02 historical execution review found repeated
`.reasonix/truncated-results/` files with explicit truncation markers. The
same review also found that current `los` can reconstruct a real run from
`task_runs` and `session_events` at operation-audit granularity, but cannot
replay exact live `model.delta` chunks from persisted state.

This creates one policy question: whether `.reasonix` truncation is a `los`
storage problem, an external-agent logging problem, or both.

## Current Evidence

Workspace `.reasonix` evidence:

1. Workspace root has `.reasonix/truncated-results/` with 15 files.
2. Every file has a terminal marker like `[..., truncated N chars ...]`.
3. The observed missing tail ranges from 1,275 to 224,000 characters.
4. The samples are command/web-fetch/codex-exec capture artifacts, not `los`
   `session_events` rows.
5. `projects/los/.reasonix/` contains only `los-review-prompt.md`.

Reasonix source evidence from local reference checkout:

1. Reasonix transcript code states that transcripts are receipts and sessions
   are memory; they are not the same storage surface.
2. Reasonix session files and `.reasonix/sessions/` are user-private and
   git-ignored.
3. Reasonix event sidecars are append-only `*.events.jsonl` files.
4. Reasonix currently skips `model.delta` in its JSONL event sink because
   deltas are recoverable from final text and would expand the sidecar.

Current `los` evidence:

1. T-1 execution observability smoke proved `task_runs` plus
   `session_events` can reconstruct task lifecycle, session lifecycle, model
   response summary, tool lifecycle, and request/trace/node/user correlation.
2. The same smoke proved exact `model.delta` stream replay is not currently
   persisted in `session_events`.
3. `contracts/run-stream.yaml` includes `model.delta` as an active stream
   event and names `session_events` plus `task_runs` as current replay sources.
4. ADR 0012 already keeps cross-gateway stream replay in the future run-state
   and run-spec work.

## Decision

1. `.reasonix/truncated-results/` is treated as an external execution capture
   cache. It is not a source of truth for `los` run replay.
2. `los` audit reconstruction remains owned by `task_runs` and
   `session_events`.
3. Exact stream replay is not solved by increasing `.reasonix` capture size.
   It belongs to ADR 0012 Phase 3, where `run_specs`, stream cursors, and
   durable run-state events can define what replay means.
4. `model.delta` retention is a separate product/runtime decision. Store it
   only when the replay requirement explicitly needs chunk-level rendering,
   token timing, or cross-gateway live stream resume.
5. External agent transcript artifacts must not be committed wholesale. Commit
   summarized evidence, marker counts, command names, and policy decisions
   instead.

## Replay Policy

Use three separate evidence classes:

| Evidence class | Source | Allowed use | Not allowed |
| --- | --- | --- | --- |
| Operation audit | `task_runs`, `session_events` | prove what ran, which provider/model/tool was used, status, usage, request ids, node ids | reconstruct exact token/chunk timing |
| Live stream | HTTP SSE / executor NDJSON during the request | render current progress and stream `model.delta` to clients | serve as durable post-run evidence after process exit |
| External capture | `.reasonix/truncated-results/`, `.omx/logs/`, terminal output | diagnose external-agent/tooling capture gaps | define `los` replay semantics or merge-gate evidence alone |

## Stream Retention Rule

Persisting all `model.delta` chunks is not a default requirement.

Promote chunk retention only when at least one of these is true:

1. cross-gateway stream resume requires `Last-Event-ID` or cursor replay of
   already emitted chunks;
2. UI replay must reproduce the exact visible token/chunk stream;
3. eval/debug work requires timing or chunk-boundary analysis;
4. provider failure analysis needs partial assistant output before
   `model.response`.

If none of these apply, persist final model response summary, usage, tool
lifecycle, request context, and failure state instead.

## Implementation Implications

1. ADR 0012 Phase 3 should decide whether to add a separate `run_state_events`
   or stream-event table before using persisted stream data as scheduler or
   failover input.
2. `session_events` should stay the audit ledger unless exact stream replay is
   promoted into the contract.
3. If chunk retention is promoted, use redaction and size policy before writing
   raw deltas because assistant output can contain copied user content, tool
   output, paths, or secrets.
4. `.reasonix` cap changes, if pursued, belong to the external Reasonix
   toolchain. They should improve external capture fidelity but should not be
   treated as a `los` replay fix.

## Verification

Evidence used:

1. `find .reasonix -maxdepth 3 -type f`
2. `rg "truncated" .reasonix docs/architecture`
3. `projects/los/docs/operations/2026-06-02-execution-observability-smoke.md`
4. local Reasonix source files:
   - `src/transcript/log.ts`
   - `src/adapters/event-sink-jsonl.ts`
   - `src/adapters/event-source-jsonl.ts`
   - `src/cli/commands/events.ts`

No raw transcript or truncated result file is required in version control for
this decision.
