# ADR 0034: User Scheduled Work State And Claim Policy

Date: 2026-07-19

Status: accepted for P2 implementation

## Context

LOS already has three different scheduling concerns. `governance_jobs` owns
LOS maintenance, external connectors own their business queues, and the agent
scheduler owns one execution attempt. None of these stores a user's recurring
goal, trigger policy, approval boundary, and per-trigger evidence as one
operator-facing object.

The Web-first workflow therefore needs a separate schedule definition and run
ledger. Reusing `governance_jobs` would mix product work with LOS maintenance;
copying lot2 or browser scheduler state would make LOS the owner of an external
business queue.

## Decision

1. `scheduled_work_items` owns user schedule definitions and current circuit
   state. `scheduled_work_item_runs` owns one due slot or manual trigger.
2. `(schedule_id, scheduled_for)` is unique. Due claims use a PostgreSQL row
   lock with `SKIP LOCKED`, insert the run, and advance `next_run_at` in one
   transaction.
3. A run has one transition owner in `packages/agent/src/scheduled-work/`.
   Routes may request an action but do not write run status directly.
4. P2 automatically executes only built-in `read_only_auto` templates that do
   not call a provider or a stateful external tool. `preapproved_scope` and
   `each_run` remain explicit contract states and produce an approval item
   until a later ADR authorizes execution.
5. Cron support is intentionally preset-shaped: daily and weekly expressions
   with explicit minute, hour, and optional weekday. Interval and once triggers
   are also supported. Natural-language cron and arbitrary cron syntax are
   rejected.
6. Trigger calculation uses the named IANA timezone. A nonexistent DST wall
   time advances to the next matching slot; an overlapping wall slot runs once.
7. `catch_up=skip` records a skipped-late run. `run_once` executes at most one
   missed slot. Concurrency is `skip`, `queue_one`, or bounded `parallel`.
8. Claimed runs carry owner and lease expiry. An expired lease may be reclaimed
   only while attempts remain. A failure updates the schedule failure counter;
   the configured threshold opens the circuit and creates one recovery Work
   Item. A successful run closes/reset the circuit.
9. Schedule results are projected into the existing Work Item/Inbox model with
   schedule and scheduled-run correlation metadata. A trigger, agent run,
   verification, and external callback remain separate evidence surfaces.

## State Models

Schedule state is `enabled`, `paused`, or `retired`, plus circuit state
`closed`, `open`, or `half_open`.

Run transitions are:

```text
queued -> claimed | skipped | cancelled
claimed -> running | awaiting_approval | skipped | failed
running -> claimed (expired lease recovery) | succeeded | no_op | failed | cancelled
awaiting_approval -> claimed | cancelled
failed -> claimed
```

`failed -> claimed` requires an expired/explicit retry, a remaining attempt,
and a non-open circuit. Terminal success, no-op, skipped, and cancelled runs do
not transition again.

## Consequences

- Two gateway/scheduler processes can poll concurrently without duplicating a
  due slot.
- Web can show next occurrences and history without treating timer activity as
  successful agent execution.
- The first release is useful for deterministic digests/readiness checks while
  keeping provider, credential, VCS, browser-login, and write actions out of
  unattended execution.
- Adding arbitrary cron, automatic `preapproved_scope`, or external connector
  payloads requires a later contract/ADR change and focused harness.

## Verification

- Policy tests cover timezone, DST, catch-up, concurrency, and legal states.
- Store tests cover duplicate claims, lease recovery, retry limit, and a single
  circuit recovery item.
- Gateway tests cover operator writes and route validation.
- Web E2E covers desktop/mobile schedule creation, preview, history, and pause.
- Migration drift, package tests, `pnpm check`, and `pnpm run gate` remain the
  delivery gates.
