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

## Current state (2026-10-18)

- `EXECUTOR_DB_MODE=none` is implemented; node34 runs with `db=none`, no
  `DATABASE_URL`, no 55432 connections.
- Task lease and agent-task lease use HTTP; artifacts use a file-backed local
  store and gateway relay.
- Session-event writes still warn and are not forwarded; file-sync is disabled.
- node34 is a **canary**. Roll back by restoring `/opt/los/.env.p3-backup` and
  restarting `los-executor`.

## Next required work

1. Gateway event-sink endpoint with client event ids, idempotency, and ack.
2. Executor outbound buffer with backlog/health + drain before task completion.
3. File-sync policy: gateway-managed or `none`-only nodes explicitly unsupported.
4. Fault injection: gateway restart during task, duplicate event retries, buffer
   overflow, event gap detection.
5. Only then promote `none` from canary to the remote default.
