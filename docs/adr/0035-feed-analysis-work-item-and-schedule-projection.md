# ADR 0035: Feed Analysis Work Item And Schedule Projection

- Status: Accepted
- Date: 2026-07-19

## Background

LOS already owns the feed-analysis dispatch, run spec, task run, validated result,
callback event, and callback delivery records. Those records are reachable through
the integration API but are absent from the Web-first Work and Inbox read model.
The user therefore cannot inspect connector progress without correlating ids across
integration, run, and callback tables.

The existing lot2extension contract remains the boundary. lot2extension owns browser
capture, its business queue, local result persistence, and callback ingestion. LOS
must not import lot2extension source or persist its business tables.

## Decision

1. Each feed-analysis dispatch owns one deterministic Todo-backed Work Item and one
   `work_item_runs` lineage record. Migration 045 backfills existing dispatches.
2. `feed_analysis_dispatches.work_item_id` is the durable correlation key. The Todo
   metadata stores only connector identity and a run-contract summary, not captured
   material or credentials.
3. The Work Item projection exposes four independent surfaces: dispatch status, LOS
   run/task status, validated result availability, and callback delivery status with
   latency. No combined connector status is persisted.
4. A completed dispatch without a persisted validated result is
   `verification_blocked`. A callback dead-letter is `recovery_required`. A completed
   dispatch with a validated result is `review_ready`.
5. The `scheduled_feed_analysis` template reuses
   `FeedAnalysisDispatchRequest` minus `sourceJobId`. The runner derives a stable
   source job id and idempotency key from the scheduled run. It is allowed only under
   an operator-created `preapproved_scope` schedule.
6. Schedule completion means the dispatch was accepted. It does not mean the LOS run,
   result validation, or callback delivery succeeded. Those later states remain on
   the linked feed-analysis Work Item.

## Ownership

- `packages/agent/src/integration/` owns dispatch-to-Work-Item correlation and
  callback evidence queries.
- `packages/agent/src/work-items/` owns attention classification.
- `packages/agent/src/scheduled-work/` owns scheduled request derivation and trigger
  outcome.
- `packages/web` renders connector evidence and does not infer state from labels.

## Safety

- The schedule never stores a service token, callback URL, callback secret, or raw
  operator credential.
- The scheduled template cannot select arbitrary tools or shell commands.
- Idempotent schedule retry reuses the same source job id and dispatch id; it does not
  create a second business result.
- Feed-analysis cancellation remains owned by the existing integration route and task
  transition path.

## Verification

- Focused tests cover completed-without-result classification, callback delivery
  evidence, stable scheduled request identity, duplicate dispatch retry, and sequence
  ordering constraints.
- Gateway tests cover Work Item correlation in dispatch receipts.
- Web tests cover distinct connector, run, result, and callback labels.
- A live smoke covers dispatch, status, result, cancel, callback delivery, and
  idempotent retry after gateway/executor restart.
