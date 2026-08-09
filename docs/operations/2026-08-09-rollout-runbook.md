# Rollout Runbook — drain / restart / ready / smoke

Date: 2026-08-09  
Status: active operator procedure  
Related: ADR 0012 (service plane), PR #243 (scheduled-work lease/dedupe)

## Policy (do not re-open)

1. **Control plane** = gateway process embedded timers (scheduled-work, governance wake, reapers). There is **no** separate main-GA daemon that assigns all sub-agents.
2. **Supervision** = launchd/`los.sh` for process life, `/live`+`/ready`+drain/promote for traffic, leases/heartbeats for long work. Health synthesizer **reports only** — it never claims work.
3. **Upgrade** = drain → restart → ready → smoke. Not classic dual-env blue-green. Dual-gateway failover remains optional scale-out (ADR 0012 Phase 2), not daily path.
4. **No auto binary push** (G11). Human-owned rollout.

## Single-node daily path (MBP / primary)

```bash
# 0. Confirm change is on main
git fetch origin   # or: jj git fetch --remote github
# working tree should track main tip with the intended merge

# 1. Optional: drain if dual-instance routing exists
# curl -X POST -H "Authorization: Bearer $LOS_AUTH_TOKEN" \
#   -H "x-los-operator-token: $LOS_OPERATOR_TOKEN" \
#   http://127.0.0.1:8080/services/<serviceId>/drain

# 2. Restart local runtime (gateway + executor + channels)
./tools/los.sh restart

# 3. Liveness
curl -fsS http://127.0.0.1:8080/health
curl -fsS http://127.0.0.1:8080/ready   # may require auth depending on config

# 4. Synthesized board (services / executors / schedules / GA circuits)
curl -fsS -H "Authorization: Bearer $LOS_AUTH_TOKEN" \
  http://127.0.0.1:8080/ops/runtime-health | jq '{overall,blockers,warnings,services,executors,schedules,governance}'
# or: pnpm --filter @los/cli exec node dist/index.js health --full
#     (or los health --full when on PATH)

# 5. Smoke a long scheduled_execution (must stay attempt=1, no dedupe fail)
curl -fsS -X POST \
  -H "Authorization: Bearer $LOS_AUTH_TOKEN" \
  -H "x-los-operator-token: $LOS_OPERATOR_TOKEN" \
  -H 'content-type: application/json' \
  "http://127.0.0.1:8080/scheduled-work-items/<scheduleId>/trigger" \
  -d '{}'
# Poll:
curl -fsS -H "Authorization: Bearer $LOS_AUTH_TOKEN" \
  "http://127.0.0.1:8080/scheduled-work-items/<scheduleId>" \
  | jq '.runs[0] | {id,status,error,attemptCount,taskRunId,startedAt,completedAt}'
```

### Pass criteria

| Check | Pass |
|---|---|
| `/health` | `status=ok` (or equivalent) |
| `/ops/runtime-health` | `overall` is `ok` or `degraded` with known warnings only; **no** `services:no_ready_gateway` |
| Smoke schedule run | `status=succeeded`, `attemptCount=1`, no error containing `deduplicated` |
| Duration | Multi-minute runs OK (execution lease 30m + heartbeat) |

### Known good smoke schedules (2026-08-09)

| Title | Schedule id (host DB) |
|---|---|
| network-observe daily trend analysis v5 | `schedule-89a3883c-38fc-49b4-a368-b4c0c5e8e254` |
| surge log error analysis (6h) v4 | `schedule-590a6cb0-bc19-46b7-a2dd-d4bd06d133c8` |

Evidence: both succeeded attempt=1 after PR #243 deploy (~4 minutes each).

## Dual-gateway path (optional)

Only when two gateways share PostgreSQL and a router consumes `/ready`:

1. Ensure gateway-B is ready and promoted.
2. Drain gateway-A; confirm router stops sending new traffic to A.
3. Upgrade/restart A; wait `/ready`.
4. Promote A; drain B if B is the old version; upgrade B.
5. Smoke via either instance; durable state is in PostgreSQL.

Do **not** attempt live in-process task migration. Rely on leases + recovery.

## Anti-patterns

- Adding a second process that claims the same scheduled runs or GA jobs.
- Treating process restart as failure if durable run/task evidence continues.
- Reclaiming `schedule-exec-*` work while the agent `task_run` is still active (fixed in PR #243).
- Promoting providers/kernels without canary gates (Pi K path is separate).

## Related surfaces

| Surface | Role |
|---|---|
| `GET /health` | Process summary |
| `GET /ops/runtime-health` | Aggregated board (this runbook step 4) |
| `GET /ops/daily-digest` | Day-scoped schedule/usage/quality |
| `GET /services` + drain/promote | Service plane (ADR 0012) |
| scheduled-work lease/heartbeat | Long agent schedule safety |
