# 2026-08-03 Interrupted-Run Recovery Smoke (G1)

## Scope

G1 drill from `docs/governance/2026-08-06-daily-use-gap-analysis.md`: prove
resume behavior across a real interrupted run — kill the gateway → restart →
resume the same run. Two interruption windows are exercised:

- **Scenario A (dispatch-window kill)**: run is `plan_approved` with no task
  attempt when the gateway dies. Restart must auto-resume it
  (`recoverApprovedRunDispatches` in `packages/gateway/src/run-resume-recovery.ts`)
  and the run finishes `succeeded`.
- **Scenario B (in-flight kill)**: gateway dies while the task is running on
  the executor. The task lease (30s) expires, restart fences the orphaned task
  (`gateway_startup_recovery`), the run lands `blocked`, and the operator
  resumes the same run via revise-plan → approve → dispatch → verify.

Both scenarios are frozen as a repeatable smoke:

- `tools/smoke-interrupted-run-recovery.sh --scenario auto|in-flight`
- `tools/smoke-interrupted-run-inject.ts` (run spec injection)

## Environment

- Gateway: `gateway-echers-mbp-local-8080`, `http://127.0.0.1:8080`
  (launchctl-managed; `kill -9` is followed by an auto-restart, observed in
  both scenarios)
- Executor: `mbp-executor-1`, `http://127.0.0.1:8090`
- Shared local PostgreSQL; provider DeepSeek (default), proxy
  `http://127.0.0.1:6152`
- Auth: `x-los-operator-token` header

No tokens, raw prompts, or transcript payloads are recorded here.

## Evidence — Scenario A (auto resume)

Run: `run-smoke-interrupted-1785765127a` (revision 1)

- [E] Gateway pid `42970` killed with `kill -9` at 21:52:10 while the run was
  `plan_approved` / `created` with no `task_runs` row (verified in DB before
  the kill).
- [E] After restart (launchctl brought up pid `46833`), gateway log printed:
  `[13:52:15] INFO [gateway] Gateway startup resumed 1 approved run dispatch(es)`.
- [E] Run state transitioned `running` → `blocked` (verification pending for
  required check `echo los-interrupted-run-recovery-smoke-ok`) → `POST
  /runs/:id/verify` returned `decision: succeeded` → final `phase=succeeded`.
- [E] DB final state: `run_specs.status=succeeded`,
  `run_contract_json.phase=succeeded`, `planRevision=1`; one task run
  (`task-f43ffdcc-…`, node `mbp-executor-1`,
  `dedupe_key=run:…:execution:1`) `succeeded`; verification record
  `verification-run-smoke-interrupted-1785765127a-r1-1` `succeeded`.

**Proven**: an approved run whose dispatch never persisted is automatically
dispatched again after gateway restart and completes without operator action
(other than the standard verify step).

## Evidence — Scenario B (in-flight kill + operator resume)

Run: `run-smoke-interrupted-1785765192i`

- [E] Run injected as `planning`, `POST /runs/:id/approve` returned
  `phase=plan_approved`, `dispatch.status=scheduled` (revision 1); task went
  `running` on `mbp-executor-1` (execution window ~10s via `sleep 10` prompt).
- [E] Gateway pid `46833` killed with `kill -9` at 21:53:15 while the task was
  `running`. Last heartbeat 13:53:15; lease expiry 13:53:45 (30s lease).
- [E] Restart at 13:54:11: startup recovery fenced the orphaned task —
  `task_runs.status=failed`,
  `metadata_json.recoveryReason="gateway_startup_recovery"` (DB verified).
  Run landed `blocked`.
- [E] `POST /runs/:id/recover` decision: `status=clean`,
  `recommendation=none` (no active/stale tool-call state — the agent had
  finished its loop independently on the executor).
- [E] Operator resume of the same run: `POST /runs/:id/revise-plan`
  (`planRevision 1→2`, `phase planning`) → `POST /runs/:id/approve`
  (`plan_approved`, dispatch scheduled) → new task
  (`task-2f680add-…`, `dedupe_key=run:…:execution:2`) executed and reached
  `blocked` (verification pending) → `POST /runs/:id/verify` →
  `decision: succeeded` → final `phase=succeeded`.
- [E] DB final state: `run_specs.status=succeeded`, `phase=succeeded`,
  `planRevision=2`; revision-1 task `failed` (fenced), revision-2 task
  `succeeded`; verification record r2-1 `succeeded` (r1-1 left `required` —
  only the current revision's checks are executed).

**Proven**: an interrupted in-flight run does not silently lose its result
state — the orphaned attempt is fenced with an audit reason, the run is
`blocked` for operator visibility, and the same run can be resumed on a new
plan revision through the public API surface.

## Observational note (non-scripted variant)

An earlier manual run (`run-smoke-interrupted-1785764753c`) exposed a second
realistic outcome for the same scenario: when the executor's independent
completion callback lands before the lease expires, the task finishes
`blocked` (verification pending, `recoveryReason` null) instead of being
fenced. Both outcomes converge to `blocked` run + revise/approve/verify
resume. The frozen script forces the fence variant by waiting 40s (lease 30s)
before restart.

## Result

- [E] Scenario A — automatic dispatch recovery after gateway restart: passed.
- [E] Scenario B — in-flight kill, lease fence with audit reason, operator
  resume of the same run to succeeded: passed.
- [E] Repeatable smoke script verified end-to-end for both scenarios.

## Residual risk / follow-up

- [I] The resume requires operator action (revise-plan + approve + verify);
  there is no automatic redispatch of `blocked` runs. If G1 wants
  crash-transparent continuation, that is a separate change (see G4-related
  recovery semantics).
- [I] `revision-1` verification records of resumed runs remain `required`
  forever; only the current revision is evaluated. Acceptable today, noted for
  the eval-corpus backlog.
- [I] The `kill -9` window is timing-sensitive in Scenario B: if the executor
  completion callback beats the lease expiry, the fence path does not trigger
  (see observational note). The script's 40s wait makes the fence variant
  deterministic.
