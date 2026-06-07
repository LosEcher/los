# 2026-06-07 Cross-Gateway Failover Recovery Smoke

## Observation

This smoke verifies the cross-gateway session failover surface:

1. `GET /sessions/recoverable` lists sessions with incomplete runs and gateway
   ownership/liveness status;
2. `POST /runs/:id/claim` transfers run ownership to a new gateway;
3. `POST /chat` with `sessionId` resumes a session from its last checkpoint;
4. `GET /sessions/:id/events/stream?since=N` replays missed events.

## Prerequisites

Two gateway instances:
- Gateway A: `http://127.0.0.1:8080` (primary)
- Gateway B: `http://127.0.0.1:8081` (standby)

Both sharing the same PostgreSQL and Redis instances.

## Procedure

### Phase 1: Create an active session on Gateway A

```bash
# Start a chat with a long-running prompt on Gateway A
curl -N http://127.0.0.1:8080/chat \
  -H 'Content-Type: application/json' \
  -d '{"prompt":"run a multi-step task: create a file, read it back, then delete it","sessionId":"failover-test-001","toolMode":"project-write","maxLoops":10}'
```

Expected: SSE stream with `session`, `task`, `turn`, and `done` events. Note the
`runSpecId` from the `session` event body.

### Phase 2: Verify gateway ownership

```bash
# Check that the run spec is owned by Gateway A
curl http://127.0.0.1:8080/runs/RUN_SPEC_ID | jq '.gatewayId'
```

Expected: Gateway A's service ID (e.g., `gateway-127.0.0.1-8080`).

### Phase 3: Simulate Gateway A failure

Stop Gateway A:

```bash
# Kill Gateway A
kill GATEWAY_A_PID
```

Wait 5 seconds for the heartbeat to expire. Verify Gateway A is offline:

```bash
curl http://127.0.0.1:8081/services | jq '.[] | select(.serviceId == "gateway-127.0.0.1-8080") | .status'
```

Expected: `"offline"` (or the service is absent from the list entirely).

### Phase 4: Discover recoverable sessions on Gateway B

```bash
curl http://127.0.0.1:8081/sessions/recoverable | jq '.'
```

Expected: JSON array with the `failover-test-001` session, its incomplete run
specs, and `gatewayOnline: false` for Gateway A's runs.

### Phase 5: Claim orphaned run on Gateway B

```bash
curl -X POST http://127.0.0.1:8081/runs/RUN_SPEC_ID/claim \
  -H 'Content-Type: application/json' \
  -d '{"gatewayId":"gateway-127.0.0.1-8081"}'
```

Expected: `{"ok": true, "runSpec": {...}, "claimedBy": "gateway-127.0.0.1-8081"}`.
The run spec's `gatewayId` is now Gateway B.

### Phase 6: Resume session on Gateway B

```bash
curl -N http://127.0.0.1:8081/chat \
  -H 'Content-Type: application/json' \
  -d '{"prompt":"resume after failover","sessionId":"failover-test-001","toolMode":"project-write","maxLoops":10}'
```

Expected: SSE stream with `session.resumed` event showing the previous turn count
and message count, followed by continued execution.

### Phase 7: Verify event replay

```bash
# Replay events from the last known event ID
curl "http://127.0.0.1:8081/sessions/failover-test-001/events/stream?since=LAST_EVENT_ID"
```

Expected: SSE stream replaying all events generated after `LAST_EVENT_ID`.

## Validation Checks

- [ ] Gateway B lists recoverable sessions with `gatewayOnline: false` for Gateway A's runs
- [ ] `POST /runs/:id/claim` transfers ownership successfully
- [ ] Claim refused for non-existent run spec (404)
- [ ] `POST /chat` with the same `sessionId` on Gateway B resumes from checkpoint
- [ ] `session.resumed` event shows `messageCount` and `turnCount` from before failover
- [ ] `GET /sessions/:id/events/stream?since=N` replays events correctly

## Remaining Risk

This is a manual recovery procedure. The following automated recovery paths
remain future work:

1. Gateway B auto-detecting Gateway A failure via heartbeat expiry and
   auto-claiming orphaned sessions.
2. Automatic /chat resumption without operator intervention.
3. Multi-gateway leader election for active/standby roles.
4. End-to-end automated failover test with simulated gateway crash.
