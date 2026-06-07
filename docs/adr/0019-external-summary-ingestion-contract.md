# ADR 0019: External Summary Ingestion Contract

## Status

Accepted.

## Context

ADR 0015 and ADR 0016 keep raw external transcripts, `.omx` logs, local tool
captures, and truncated outputs outside `los` runtime replay. The remaining
gap is a bounded way to store operator-reviewed summaries from Codex, Claude
Code, Reasonix, OpenCode, OMX, Gemini, and browser tools without pretending
they are `task_runs`, `session_events`, `run_specs`, `verification_records`, or
provider compatibility evidence.

## Decision

Add a dedicated `external_tool_summaries` table and import route for redacted
summary objects accepted by `packages/agent/src/external-tool-summary.ts`.

This ingestion is allowed only for `evidenceClass = external_summary`.

Storage location:

1. `external_tool_summaries` stores the normalized summary JSON plus queryable
   tool, source kind, source reference, labels, metrics, source hash, importer,
   capture policy, redaction policy, and optional retention expiry.
2. No imported summary writes to `session_events`, `task_runs`, `run_specs`,
   `verification_records`, or provider compatibility tables.

Source authenticity:

1. Each import records `tool`, optional `toolVersion`, `source.kind`,
   `source.sourceRef`, optional `source.cwd`, optional `source.capturedAt`,
   `provenance.collectedAt`, `capturePolicy`, `redactionPolicy`, and
   optional `importedBy`.
2. The importer is responsible for source review. The table records provenance;
   it does not certify external tool identity.
3. `sourceHash` is computed from the normalized summary payload to make repeat
   imports comparable.

Queryable fields:

1. tool;
2. source kind and source reference;
3. labels;
4. scalar metrics;
5. redaction status and replacement count;
6. created and updated timestamps;
7. optional retention expiry.

Retention and deletion:

1. Imports may include `retentionDays`, which produces `retentionExpiresAt`.
2. Listing routes hide expired records by default.
3. Deletion or pruning can be added later as an operation command; retention
   metadata exists now so the policy is explicit.

Runtime evidence isolation:

1. Raw transcripts, prompts, stdout, stderr, raw tool output, auth snapshots,
   cookies, API keys, and bearer-token shaped fields are rejected before
   storage.
2. Allowed summary text is redacted for known secret-like patterns before
   persistence.
3. The table has a check constraint requiring `evidence_class =
   'external_summary'`.
4. Import routes and CLI commands are named `external-summaries`, not `runs`,
   `sessions`, or `tasks`.

## Consequences

`los` can now retain bounded external comparison evidence while preserving the
runtime evidence boundary. Imported summaries can inform planning, docs, todos,
and review context, but cannot be used as replay proof or verifier evidence
unless a later ADR creates a separate promotion path.

## Verification

Required checks:

1. adapter/store test proves redaction, retention metadata, and
   `external_summary` class;
2. route test proves import/list behavior and raw-field rejection;
3. `pnpm check` must pass after schema and route changes.
