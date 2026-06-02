# ADR 0016: OMX Tool-Level Logging Scope

Status: Accepted

Date: 2026-06-02

## Background

The 2026-06-02 historical execution review raised `.omx` tool-level logging as
a possible observability gap. The question is whether that gap belongs in
`los`, in the external OMX/Codex toolchain, or in a future ingestion adapter.

This ADR scopes `.omx` logging against the current `los` evidence model so that
external-agent capture work does not duplicate or weaken `session_events`.

## Current Evidence

Workspace `.omx` evidence:

1. Workspace root `.omx/logs/` currently has six daily `omx-*.jsonl` files.
2. Those files contain 24 observed rows.
3. Every observed row has `event=session_start`.
4. The observed daily log schema is limited to:
   `event`, `session_id`, `native_session_id`, `pid`, `timestamp`, and `_ts`.
5. No observed `.omx/logs/omx-*.jsonl` row contains `tool_call`,
   `tool_result`, model output, exit status, token usage, cost, transcript
   content, or error payloads.
6. `.omx/state/session.json` stores session identity, native session identity,
   cwd, pid, platform, and start time.
7. `.omx/state/sessions/*` currently stores prompt-routing and skill activation
   state, not tool execution evidence.

OMX hook source evidence from the installed local package:

1. `~/.codex/hooks.json` registers Codex hook handlers for `SessionStart`,
   `PreToolUse`, `PostToolUse`, `UserPromptSubmit`, and `Stop`.
2. `codex-native-hook.js` maps `PreToolUse` and `PostToolUse` to OMX hook
   events and dispatches them through the hook plugin dispatcher.
3. `hooks/session.js` `appendToLog()` writes `.omx/logs/omx-<date>.jsonl`.
   The verified call sites write session lifecycle entries and subagent
   session-start entries.
4. `codex-native-pre-post.js` builds advisory or blocking hook output for tool
   use, but the inspected path does not append a tool ledger row to
   `.omx/logs/omx-<date>.jsonl`.
5. The hook plugin dispatcher can append `.omx/logs/hooks-<date>.jsonl`
   dispatch rows when hook dispatch runs. That log describes plugin dispatch
   status, not a durable tool call/result ledger.

Current `los` evidence:

1. T-1 execution observability smoke proved `task_runs` plus
   `session_events` can reconstruct task lifecycle, session lifecycle, model
   response summary, tool lifecycle, request ids, trace ids, node ids, and
   user ids.
2. The same smoke proved `session_events` currently stores tool call,
   planned, approved, and result events at operation-audit granularity.
3. ADR 0015 already treats `.omx/logs/` as external capture evidence, not as
   `los` replay semantics or merge-gate evidence.

## Decision

1. Current `.omx` project logs are external toolchain session and routing
   evidence. They are not a `los` tool ledger.
2. Hook coverage does not imply durable log fidelity. A configured
   `PreToolUse` or `PostToolUse` hook is evidence that OMX can inspect the
   event; it is not evidence that the event was persisted with enough schema to
   replay or audit a tool execution.
3. `los` must not import `.omx` logs into `session_events` by default.
   `session_events` remains the owner for `los`-owned run and tool evidence.
4. Tool-level logging for external Codex/OMX sessions belongs to the OMX/global
   toolchain unless `los` later defines an explicit ingestion adapter.
5. Future `.omx` tool events, if implemented, remain external capture evidence
   until their schema, redaction, provenance, and ingestion rules are accepted
   by a separate ADR or contract.

## Owner Layers

| Work | Owner layer | Notes |
| --- | --- | --- |
| `los` run and tool audit | `task_runs`, `session_events` | Current source of truth for `los` operations |
| `los` exact stream replay | ADR 0012 Phase 3 | Requires run specs, stream cursors, and durable run-state events |
| External Codex/OMX session capture | OMX/global toolchain | May improve external visibility, but is not a `los` merge gate |
| Importing external `.omx` evidence into `los` | Future adapter ADR/contract | Requires schema, redaction, source authentication, and replay semantics |

## Minimum Schema For Any Future Tool Ledger

A future OMX-owned tool ledger should store summarized execution facts, not raw
transcripts:

1. stable session id and native session id;
2. tool name and tool call id when available;
3. start time, end time, and duration;
4. status such as planned, approved, blocked, completed, or failed;
5. exit code or error class when applicable;
6. bounded input/output summaries and byte counts;
7. cwd or workspace identity when needed for correlation;
8. source hook name and toolchain version.

This is enough for external-agent debugging. It is not enough to become a
`los` replay source without a separate ingestion contract.

## Redaction Rule

Before storing transcript-like artifacts, the owner must define and test
redaction. The minimum rule is:

1. do not store raw user prompts, raw tool stdout/stderr, raw transcripts, or
   full model responses by default;
2. do not store auth tokens, profile secrets, local auth snapshots, API keys,
   cookies, SSH keys, or bearer headers;
3. store command/tool identifiers, status, timing, bounded summaries, byte
   counts, and error classes instead of wholesale payloads;
4. if raw payload retention is required for a narrow debugging case, keep it
   local, git-ignored, time-limited, and explicitly marked as external capture;
5. never use raw external-agent capture as merge-gate truth without schema and
   redaction review.

## Implementation Implications

1. No `los` code change is required for current `.omx` logs.
2. No migration from `.omx/logs/` into `session_events` should be implemented
   in this cleanup pass.
3. If OMX adds tool call/result rows later, evaluate them as external capture
   first. Promotion into `los` requires an ingestion adapter ADR and contract.
4. For current `los` work, add tests around executor and memory behavior
   before adding more observability surfaces.

## Verification

Evidence used:

1. `find .omx -maxdepth 4 -type f`
2. `awk 'BEGIN{FS=""} {print FILENAME}' .omx/logs/*.jsonl | sort | uniq -c`
3. `jq -r '[.event] + (keys|sort) | @tsv' .omx/logs/*.jsonl | sort | uniq -c`
4. `jq 'keys' .omx/state/session.json`
5. `jq -r 'keys|join(",")' .omx/state/sessions/*/*.json`
6. installed OMX sources:
   - `dist/hooks/session.js`
   - `dist/scripts/codex-native-hook.js`
   - `dist/scripts/codex-native-pre-post.js`
   - `dist/hooks/extensibility/dispatcher.js`

No raw `.omx` log or state artifact is required in version control for this
decision.
