# ADR 0002: Internal Session Ledger For Observability And Future Query Adapters

## Status

Proposed.

## Observation

`los` already persists final session payloads in `packages/agent/src/session.ts` and memory observations in `packages/memory/src/store.ts`, but that only captures end-state data.

The runtime also already has the pieces needed for richer evidence:

- `packages/agent/src/loop.ts` knows every turn, tool call, and tool result.
- `packages/agent/src/providers/index.ts` returns token usage and model identity.
- `packages/gateway/src/server.ts` owns the live chat boundary and can expose read APIs.

## Inference

If session history is only written at the end, los loses the intermediate evidence needed for replay, compact-resume analysis, cache inspection, and tool/model optimization.

The right base layer is an append-only internal event ledger with normalized projections on top. External JSONL sources such as Codex and Claude should remain adapter inputs later, not the primary runtime truth.

## Decision

Add an internal `session_events` ledger in PostgreSQL and write it during agent execution.

Keep these projections separate:

1. raw session events
2. session observability summaries
3. memory observations
4. future external-source adapters

Reserve projection nodes for:

- cache hit/miss analysis
- tool usage analysis
- model routing analysis
- external session adapters for Codex / Claude / other JSONL sources

## Placement

The base write path belongs in `packages/agent`.
The read surfaces belong in `packages/gateway`.
Longer-term external adapters should live beside the ledger, not inside memory or the chat transcript path.

## Verification

Confirm:

1. agent turns emit session events without blocking the main path on transient logging failures.
2. `/sessions/:id/events` returns the raw event timeline.
3. `/sessions/:id/observability` returns a projection with cache/tool/model summaries.
4. no external-source write path is introduced yet.

