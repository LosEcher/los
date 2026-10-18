# Executor DB mode and state ownership

Date: 2026-10-18

## Decision

- **Control plane owns durable state.** Gateway-local execution and any node that
  needs offline/file-sync state use `EXECUTOR_DB_MODE=required`.
- **Remote fleet executors target `EXECUTOR_DB_MODE=none`.** They own only:
  current task memory, a local artifact CAS, an outbound event buffer, and lease
  tokens.
- **No runtime auto-fallback.** "Has DATABASE_URL, therefore use DB" is not a
  mode. A node declares `required` or `none`; a 401/409 must fail, not quietly
  reconnect to the DB.
- **`none` is a canary until the event sink lands.** Task leases, agent leases,
  and artifacts are already HTTP/local; session events and file-sync are not.
  A no-DB node must not be presented as a complete event-sourced executor.

## Why

1. **Maintainability**: one schema owner and one migration surface. Remote nodes
   stop drifting with gateway schema versions.
2. **Extensibility**: executors can be ephemeral or horizontally scaled without
   DB credentials; placement becomes capability-based.
3. **Observability**: no-DB only works if every event is acknowledged by the
   gateway and backlog is visible. Silent local execution is worse than DB mode.
4. **Traceability**: task tokens, trace ids, client event ids, sequence numbers,
   and artifact checksums are the evidence; direct executor DB writes bypass the
   gateway audit boundary.

## Current state (2026-10-18, after P4)

- `EXECUTOR_DB_MODE=none` is implemented; node34 runs with `db=none`, no
  `DATABASE_URL`, no 55432 connections.
- Task lease and agent-task lease use HTTP; artifacts use a file-backed local
  store and gateway relay.
- Session events use a gateway endpoint, `client_event_id` idempotency, disk
  spool, startup replay with node credential, per-task spool cap, and health
  `eventBacklog`/`spoolBacklog`.
- Explicit `POST /tasks/:id/complete` converges task and scheduled runs; the
  reaper and an orphan sweep provide the failure-path backstop.
- No-DB nodes report `file_sync_scan/deep_verify/enabled=false`; placement
  rejects file-sync work.
- node34 is still a **canary**, not the remote default. Roll back by restoring
  `/opt/los/.env.p3-backup` and restarting `los-executor`.

## P4 close decision

P4 closed under the **fail-closed** branch of its acceptance:

- normal scheduled no-DB task: succeeded, node34, events delivered,
  `eventBacklog=0`, `spoolBacklog=0`;
- gateway restart during a long task: the task was reaped as failed and the
  linked scheduled run was converged to failed; running scheduled runs = 0;
- headless approval without a channel is fail-closed (`tool.approval_required`),
  not silently executed.

Not proven: a task **succeeding across** a gateway restart. Gateway startup has
been observed at tens of seconds to minutes, so the 300s scheduled lease is a
budget, not a guarantee. `none` is therefore **not promoted** to the remote
default.

## Next required work

1. Either prove restart-survival with a controlled restart budget, or explicitly
   ratify fail-closed as the final P4 semantics.
2. Headless approval usability: blocked vs failed policy, or forbid
   approval-required tools on stateless scheduled runs.
3. Provider authority decision (cc-switch / DSH / los / optional Magpie edge).
4. Artifact GC/quota, Postgres + artifact + losvault backup/restore drills.
5. Global event sequence/gap detection and provider cost/quota observability.
