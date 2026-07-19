# ADR 0037: Daily Agent Quality Snapshots

- Status: Accepted
- Date: 2026-07-19

## Background

LOS now exposes Web-first Inbox, Work, and Schedules views, while provider/model
run quality remains available through `run_evals`. Those current-state and event
surfaces answer operational questions, but they cannot reconstruct how many Inbox
items were actionable or how old they were at an earlier point in time.

The first quality baseline therefore needs a persisted daily read model. The
initial capture establishes collection only; it does not provide a four-week
trend or prove that daily use has improved.

## Decision

1. `daily_agent_quality_snapshots` stores one snapshot per
   `(tenant_id, project_id, snapshot_date)`. `snapshot_date` is a UTC date used
   for idempotency; `captured_at`, `window_start`, and `window_end` preserve the
   actual observation window.
2. A same-day capture uses PostgreSQL `ON CONFLICT ... DO UPDATE`. Multiple
   gateways may capture concurrently without creating duplicate evidence. The
   latest successful capture for that UTC date becomes the retained snapshot.
3. Inbox metrics are a point-in-time projection: actionable count, attention
   categories, oldest age, and counts older than 24 and 72 hours.
4. Schedule, recovery, verification, and provider/model quality remain separate
   objects. LOS does not combine them with runtime health, provider readiness,
   quota, compatibility, or cost into one score.
5. Provider/model metrics are derived from project-scoped `run_evals`. Runtime
   service and executor health continue to use their existing registries and
   health endpoints.
6. Automatic capture is a read-only gateway maintenance task. It performs no
   provider call, tool execution, Todo transition, retry, recovery, or schedule
   dispatch. An operator route can request the same idempotent capture.
7. The evidence window is `complete` only when every UTC date in the latest
   28-day interval has a snapshot. Otherwise it is `collecting` and reports the
   missing dates. A baseline capture must not be presented as a trend.

## Ownership

- `contracts/daily-agent-quality.yaml` owns the HTTP and response contract.
- `packages/agent/src/daily-agent-quality/` owns aggregation, persistence, and
  evidence-window semantics.
- `packages/gateway/src/routes/data/` owns query and operator capture routes.
- `packages/gateway/src/server-maintenance.ts` owns timer registration through a
  small extracted daily-quality maintenance module.
- `packages/web` renders the operational quality view under Evals while keeping
  provider/model eval summary and comparison as independent tabs.

## Metric Semantics

- `inbox` is current at `captured_at`; age is measured from each entry's
  `updatedAt` to `captured_at`.
- `schedule` counts scheduled work runs whose `scheduled_for` is inside the
  stored observation window. Lateness is `started_at - scheduled_for`, clamped
  at zero and reported only when a run has started.
- `recovery` reports current recovery-required Inbox items, recovery events in
  the window, retry attempts, and successful retried task or scheduled runs.
- `verification` reports current required-record coverage for the project,
  including inferred missing requirements from Work Item contracts.
- `providerQuality` reports project-scoped run eval success, latency, retries,
  tool errors, and model cost inside the observation window.

## Safety And Limits

- Snapshot JSON contains aggregate counts only. It must not include prompts,
  transcripts, tool inputs, credentials, captured business material, or raw
  provider responses.
- lot2extension and CanTool remain external reference systems. Their private
  stores are not queried or copied into this read model.
- Historical Inbox state before the first capture is unavailable. Schedule,
  verification, and eval history do not justify synthesizing old Inbox
  snapshots.
- UTC is the first stable boundary. Project timezone support requires a later
  contract revision because it changes uniqueness and evidence-window meaning.

## Verification

- Deterministic tests cover category counts, age thresholds, retry success,
  idempotent same-date replacement, and 28-day missing-date detection.
- Gateway tests cover request scope, operator capture, and baseline reads.
- Web tests cover separated tabs and explicit `collecting`/`complete` evidence.
- Migration drift, package checks, root checks, and the full gate verify the
  cross-package change.
