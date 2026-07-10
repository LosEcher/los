import { loadConfig } from '../packages/infra/src/config.js';
import { closeDb, getDb, initDb, withDbClient } from '../packages/infra/src/db.js';

const REPAIR_ID = 'p0-run-state-20260710-v1';

type CandidateRow = {
  id: string;
  session_id: string;
  status: string;
  run_contract_json: Record<string, unknown>;
  phase: string | null;
  plan_count: number;
  task_count: number;
  verification_count: number;
  run_succeeded_event_count: number;
};

type RepairDecision = {
  runSpecId: string;
  sessionId: string;
  classification: 'legacy_missing_phase' | 'empty_plan_not_executed' | 'empty_plan_succeeded_legacy';
  before: { status: string; phase: string | null; planCount: number };
  after: { status: string; phase: string | null };
  evidence: { taskCount: number; verificationCount: number; runSucceededEventCount: number };
  legacy: boolean;
  needsReview: boolean;
};

const CANDIDATE_SQL = `
SELECT r.id, r.session_id, r.status, r.run_contract_json,
       r.run_contract_json->>'phase' AS phase,
       COALESCE(jsonb_array_length(CASE
         WHEN jsonb_typeof(r.run_contract_json->'plan') = 'array' THEN r.run_contract_json->'plan'
         ELSE '[]'::jsonb END), 0)::int AS plan_count,
       (SELECT count(*)::int FROM task_runs t WHERE t.run_spec_id = r.id) AS task_count,
       (SELECT count(*)::int FROM verification_records v WHERE v.run_spec_id = r.id) AS verification_count,
       (SELECT count(*)::int FROM session_events e
          WHERE e.session_id = r.session_id AND e.type = 'run_spec.succeeded') AS run_succeeded_event_count
FROM run_specs r
WHERE r.run_contract_json #>> '{p0Repair,repairId}' IS DISTINCT FROM $1
  AND (
    (r.run_contract_json->>'phase' IS NULL AND r.status IN ('succeeded', 'failed', 'cancelled', 'blocked'))
    OR (
      r.run_contract_json->>'phase' IN ('plan_approved', 'executing', 'verifying', 'succeeded', 'blocked')
      AND COALESCE(jsonb_array_length(CASE
        WHEN jsonb_typeof(r.run_contract_json->'plan') = 'array' THEN r.run_contract_json->'plan'
        ELSE '[]'::jsonb END), 0) = 0
    )
    OR (r.status IN ('succeeded', 'failed', 'cancelled') AND r.run_contract_json->>'phase' IS DISTINCT FROM r.status)
    OR (r.status = 'blocked' AND r.run_contract_json->>'phase' IS DISTINCT FROM 'blocked')
  )
ORDER BY r.updated_at, r.id
`;

function decide(row: CandidateRow): RepairDecision {
  const evidence = {
    taskCount: row.task_count,
    verificationCount: row.verification_count,
    runSucceededEventCount: row.run_succeeded_event_count,
  };
  const before = { status: row.status, phase: row.phase, planCount: row.plan_count };

  if (row.plan_count === 0 && row.phase !== null) {
    if (row.status === 'created' && row.task_count === 0 && row.verification_count === 0) {
      return {
        runSpecId: row.id, sessionId: row.session_id, classification: 'empty_plan_not_executed',
        before, after: { status: row.status, phase: 'planning' }, evidence, legacy: false, needsReview: true,
      };
    }
    if (row.status === 'succeeded' && row.run_succeeded_event_count > 0) {
      return {
        runSpecId: row.id, sessionId: row.session_id, classification: 'empty_plan_succeeded_legacy',
        before, after: { status: row.status, phase: 'succeeded' }, evidence, legacy: true, needsReview: true,
      };
    }
  }

  return {
    runSpecId: row.id, sessionId: row.session_id, classification: 'legacy_missing_phase',
    before, after: { status: row.status, phase: row.phase }, evidence, legacy: true, needsReview: false,
  };
}

async function applyDecisions(decisions: RepairDecision[], actor: string, reason: string): Promise<void> {
  await withDbClient(async (client) => {
    await client.query('BEGIN');
    try {
      for (const decision of decisions) {
        const repairedAt = new Date().toISOString();
        const repair = { repairId: REPAIR_ID, actor, reason, repairedAt, ...decision };
        const phasePatch = decision.after.phase === null ? {} : {
          phase: decision.after.phase,
          previousPhase: decision.before.phase,
          phaseChangedAt: repairedAt,
        };
        const updated = await client.query<{ id: string }>(`
          UPDATE run_specs
          SET run_contract_json = run_contract_json || $2::jsonb,
              updated_at = now()
          WHERE id = $1
            AND run_contract_json #>> '{p0Repair,repairId}' IS DISTINCT FROM $3
          RETURNING id
        `, [decision.runSpecId, JSON.stringify({ ...phasePatch, p0Repair: repair }), REPAIR_ID]);
        if (!updated.rows[0]) continue;

        const payload = { runSpecId: decision.runSpecId, ...repair };
        const event = await client.query<{ id: string | number }>(`
          INSERT INTO session_events (session_id, turn, type, source, usage_json, payload_json)
          VALUES ($1, 0, 'run.data_repaired', 'los.p0-repair', '{}'::jsonb, $2::jsonb)
          RETURNING id
        `, [decision.sessionId, JSON.stringify(payload)]);
        await client.query(`
          INSERT INTO execution_outbox (session_id, run_spec_id, entity_type, entity_id, event_type, payload_json)
          VALUES ($1, $2, 'run_spec', $2, 'run.data_repaired', $3::jsonb)
        `, [decision.sessionId, decision.runSpecId, JSON.stringify({ ...payload, sessionEventId: event.rows[0]?.id })]);
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    }
  });
}

function readFlag(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  const actor = readFlag('--actor')?.trim();
  const reason = readFlag('--reason')?.trim();
  if (apply && (!actor || !reason)) throw new Error('--apply requires non-empty --actor and --reason');

  const config = await loadConfig();
  await initDb(config.databaseUrl);
  try {
    const rows = await getDb().query<CandidateRow>(CANDIDATE_SQL, [REPAIR_ID]);
    const decisions = rows.rows.map(decide);
    const summary = decisions.reduce<Record<string, number>>((counts, decision) => {
      counts[decision.classification] = (counts[decision.classification] ?? 0) + 1;
      return counts;
    }, {});
    console.log(JSON.stringify({ repairId: REPAIR_ID, mode: apply ? 'apply' : 'read-only', count: decisions.length, summary, decisions }, null, 2));
    if (apply) await applyDecisions(decisions, actor!, reason!);
  } finally {
    await closeDb();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
