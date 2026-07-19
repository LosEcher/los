# 2026-07-19 Cross-Gateway Failover Recovery Smoke

## Scope

This smoke checked the current cross-gateway control and replay surfaces using
two gateways sharing the local PostgreSQL database. It intentionally separates
persisted event replay from active task takeover.

## Environment

- Gateway A: `gateway-echers-mbp-local-8080`, `http://127.0.0.1:8080`
- Gateway B: `gateway-echers-mbp-local-8081`, temporary standby process
- Executor: `mbp-executor-1`, `http://127.0.0.1:8090`
- Provider used by the live runs: DeepSeek `deepseek-v4-flash`

No tokens, raw prompts, or transcript payloads are recorded here.

## Evidence

### Service control

- [E] Gateway A `/health` returned `status=ok`, `ready=true` after the smoke.
- [E] Gateway B `/health` returned healthy while the temporary process was
  running.
- [E] `POST /services/gateway-echers-mbp-local-8081/drain` returned
  `status=draining`; Gateway B `/ready` returned HTTP 503 with
  `status:draining`.
- [E] `POST /services/gateway-echers-mbp-local-8081/promote` succeeded; Gateway
  B `/ready` returned HTTP 200 and `ready=true` afterward.
- [E] Current runtime was restored to the managed Gateway A on port 8080 and
  executor on port 8090.

### Persisted stream replay

- [E] Completed session `phase3-failover-20260719` was replayed through Gateway
  B with `Last-Event-ID: 12301`.
- [E] The response emitted `session.resumed` for Gateway B and continued with
  persisted event IDs `12302`, `12303`, and later events.
- [I] This demonstrates cross-gateway replay of persisted session events; it
  does not demonstrate takeover of an interrupted active provider stream.

### Active process-kill attempt

- [E] Session `phase3-failover-live-20260719` used run spec
  `run-phase3-failover-live-20260719-1784457844959` and task
  `task-775da291-aa6c-42b1-a3ea-f6d0d30f5045`.
- [E] Gateway A was killed while the task was running. The task later ended as
  `failed` with metadata `recoveryReason=gateway_startup_recovery`; the run
  ended `blocked` with `operator_attention` and no verification records.
- [E] Gateway B reported `GET /sessions/recoverable` as `count=0` during the
  recovery check, and no `POST /runs/:id/claim` takeover was completed.
- [I] The failed outcome is consistent with the current startup-recovery path
  cleaning up the orphaned task rather than handing it to another gateway.
  The exact automatic stale-heartbeat timing was not isolated in this smoke.

### Repeatable active-session harness

- [E] `packages/gateway/src/active-session-failover.test.ts` creates a session
  with a running task and a live provider-delta event, ages the old gateway
  heartbeat, and runs the same orphan-reaper path used by gateway maintenance.
- [E] The reaper fences the old task lease, records `task_run.failed`, marks the
  interrupted run spec failed, and claims it for Gateway B.
- [E] A stale Gateway A completion is rejected after takeover, while the
  persisted `model.delta` remains available for replay. This is the repeatable
  regression gate for active-session failover; it does not claim to resume the
  provider's in-flight HTTP request itself.

## Result

- [E] Gateway drain/promote control: passed.
- [E] Persisted cross-gateway stream replay: passed.
- [E] Active interrupted session discovery, fencing, claim, and replay evidence:
  covered by the gateway failover harness above.

## Residual risk / follow-up

The remaining gap is provider-specific in-flight request continuation: the
harness proves durable task fencing, automatic run claiming, and replay-backed
redispatch, but it does not keep the original provider HTTP connection alive
through a process kill.
