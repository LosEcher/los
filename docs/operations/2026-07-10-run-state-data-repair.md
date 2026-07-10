# P0-06 Run State Data Repair

Date: 2026-07-10

## Scope

The read-only audit found 60 historical candidates:

- 51 runs were created before `run_contract.phase` existed. They retain their original status and are marked `legacy_missing_phase`.
- 8 IM smoke runs had an empty approved plan, no task run, and no verification record. Their phase is restored from `plan_approved` to `planning` and they remain `needsReview`.
- 1 IM smoke run had an empty approved plan but also a persisted `run_spec.succeeded` event. Its phase is synchronized to `succeeded` and the record is marked `empty_plan_succeeded_legacy` plus `needsReview`.

No task status, run status, verification record, or historical event is deleted or fabricated. Every applied decision writes `run.data_repaired` to `session_events` and `execution_outbox`, including actor, reason, before/after values, and evidence counts.

## Applied Result

Applied on 2026-07-10 with actor `operator:local` and reason `P0-06 evidence-backed run state repair`.

- Decisions applied: 60
- `legacy_missing_phase`: 51
- `empty_plan_not_executed`: 8
- `empty_plan_succeeded_legacy`: 1
- Post-apply unresolved candidates: 0
- `run.data_repaired` session events: 60
- `run.data_repaired` outbox rows: 60

## Commands

Read-only report:

```bash
pnpm --filter @los/agent exec node --import tsx ../../tools/audit-run-state-drift.ts
```

Apply the fixed repair set:

```bash
pnpm --filter @los/agent exec node --import tsx ../../tools/audit-run-state-drift.ts \
  --apply \
  --actor operator:local \
  --reason "P0-06 evidence-backed run state repair"
```

Run the read-only command again after apply. Expected result: `count: 0`. The repair is idempotent through repair id `p0-run-state-20260710-v1`.

## Follow-up Queries

The classification is stored in `run_specs.run_contract_json.p0Repair`. Inspect one record with:

```sql
SELECT id, status, run_contract_json->>'phase' AS phase,
       run_contract_json->'p0Repair' AS repair
FROM run_specs
WHERE id = '<run-spec-id>';
```

Audit events and outbox evidence:

```sql
SELECT id, session_id, type, source, payload_json, created_at
FROM session_events
WHERE type = 'run.data_repaired'
ORDER BY id;

SELECT id, run_spec_id, event_type, payload_json, created_at
FROM execution_outbox
WHERE event_type = 'run.data_repaired'
ORDER BY id;
```
