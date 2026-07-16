# ADR 0028: Execution Outbox Delivery

## Status

Accepted.

## Context

Execution transitions atomically write `session_events` and
`execution_outbox`, but the outbox has no publisher. Cross-gateway live
notification currently depends on a best-effort PostgreSQL `NOTIFY`, while
historical outbox rows remain unpublished. Replaying every historical row at
startup would create a notification storm without improving durable replay.

## Decision

1. `session_events` remains the durable replay and cursor source of truth.
2. `execution_outbox` provides at-least-once cross-gateway notification after
   the state/event transaction commits.
3. Migration 035 marks rows created before the migration as `legacy = true`.
   New rows default to `legacy = false`. This migration boundary is the
   historical delivery watermark; publishers never claim legacy rows.
4. New outbox rows carry the matching `session_event_id`.
5. Publishers claim ready rows with `FOR UPDATE SKIP LOCKED`, a claim owner,
   and a claim TTL. Delivery failure clears the claim and schedules bounded
   exponential backoff.
6. A crash after `NOTIFY` but before `published_at` may deliver a duplicate.
   Consumers must deduplicate by the durable session-event cursor.
7. Health and diagnostics expose pending count, active claims, legacy count,
   oldest pending age, and the legacy high-watermark id.

## Consequences

- Historical rows remain queryable without being broadcast.
- Two gateway publishers cannot concurrently claim the same row.
- Notification failure is retried without blocking execution transitions.
- Notification is at least once, not exactly once.

## Verification

- Failed delivery records an error and future retry time, then succeeds after
  the retry becomes due.
- A second publisher cannot claim a row held by an active first publisher.
- Legacy rows are excluded from pending delivery and reported separately.
- Gateway health and diagnostics expose outbox backlog evidence.
