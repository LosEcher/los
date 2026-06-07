# External Tool Summary Adapter

## Background

Codex, Claude Code, Reasonix, OpenCode, OMX, Gemini, and browser tools can
produce useful comparison evidence for `los`, but their raw transcripts and
local logs are not `los` runtime evidence. ADR 0015 and ADR 0016 keep those
captures external unless a later ingestion contract defines schema,
redaction, provenance, and retention.

## Current State

`packages/agent/src/external-tool-summary.ts` defines the adapter and bounded
ingestion layer. ADR 0019 allows a dedicated `external_tool_summaries` table
and `/external-summaries` import route for redacted summaries only.

Accepted input:

1. tool identity: `codex`, `claude-code`, `reasonix`, `opencode`, `omx`,
   `gemini`, `browser`, or `other`;
2. source identity: source kind, source reference, optional cwd, and capture
   time;
3. provenance: collection time, capture policy, redaction policy, and optional
   importer;
4. bounded summary, findings, evidence references, labels, and scalar metrics.

Rejected input:

1. raw transcripts;
2. raw prompts;
3. raw stdout or stderr;
4. raw tool output;
5. auth snapshots, cookies, API keys, bearer tokens, and similar secret fields.

The adapter redacts known fake-secret patterns from allowed summary fields and
records how many replacements happened. The output is always labeled
`evidenceClass: external_summary` so callers cannot confuse it with
`task_runs`, `session_events`, `run_specs`, `verification_records`, or provider
compatibility evidence.

Persisted summaries live only in `external_tool_summaries`. Imports may include
`retentionDays`; listing routes hide expired records by default. The route and
CLI do not write to runtime evidence tables.

## Tool Comparison Boundary

| Tool | Allowed summary use | Not allowed |
| --- | --- | --- |
| Codex | scoped engineering summary, diff/test/commit references | raw thread transcript as replay |
| Claude Code | project-context summary and credential-class observations | OAuth/login state as compatibility proof |
| Reasonix | session/receipt design comparison and truncation markers | truncated capture as complete run evidence |
| OpenCode | execution UX and plan/build ergonomics | current `los` runtime source of truth |
| OMX | hook/log coverage summary and tool-ledger candidate facts | `.omx` log import as `session_events` |
| Gemini | lightweight second-opinion summary | unverified current-state claim |
| Browser tools | bounded UI observation and screenshot reference | UI display as persisted execution proof |

## Verification

Executable checks:

1. `packages/agent/src/external-tool-summary.test.ts` proves fake API key and
   bearer-token redaction.
2. The same test rejects raw transcript and nested raw stdout fields.
3. `packages/agent/src/eval-backlog.test.ts` keeps E04 and E17 present in the
   eval backlog with required evidence and passing patterns.

## Ingestion Contract

ADR 0019 answers the promotion gate:

1. external summaries live in `external_tool_summaries`;
2. provenance records source kind, source reference, tool, version, cwd,
   capture policy, redaction policy, importer, and source hash;
3. tool, source kind, labels, metrics, redaction status, and timestamps are
   queryable;
4. retention is represented by optional `retentionExpiresAt`;
5. imports cannot overwrite `los` runtime evidence because they do not touch
   `session_events`, `task_runs`, `run_specs`, `verification_records`, or
   provider compatibility tables.
