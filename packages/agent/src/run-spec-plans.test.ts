import test from 'node:test';
import assert from 'node:assert/strict';

import { closeDb, getDb, initDb } from '@los/infra/db';
import { loadConfig } from '@los/infra/config';
import { createRunSpec, loadRunSpec } from './run-specs.js';
import { persistRunSpecPlan } from './run-spec-plans.js';
import { listSessionEvents } from './session-events.js';
import { listVerificationRecordsForRunSpec } from './verification-records.js';

test('persistRunSpecPlan records an approvable plan without completing the run', async () => {
  const config = await loadConfig();
  await initDb(config.databaseUrl);
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const id = `run-planning-${suffix}`;
  const sessionId = `session-planning-${suffix}`;

  try {
    await createRunSpec({
      id,
      sessionId,
      prompt: 'Plan a bounded change',
      workspaceRoot: process.cwd(),
      toolMode: 'project-write',
      runContract: {
        mode: 'execution',
        executionMode: 'standard',
        phase: 'planning',
        requiredChecks: ['pnpm check'],
      },
    });
    const updated = await persistRunSpecPlan(id, {
      plan: [{
        id: 'implementation',
        title: 'Implement the change',
        description: 'Update the bounded implementation surface.',
        dependsOnIds: [],
        editableSurfaces: ['packages/agent/src/'],
        completionCriteria: 'The focused test passes.',
      }],
      verifications: [{
        id: 'focused-test',
        kind: 'command',
        description: 'Run the focused test.',
        command: 'pnpm --filter @los/agent test',
      }],
      actor: 'planner-test',
      summary: 'One bounded implementation step.',
    });

    assert.equal(updated.status, 'created');
    assert.equal(updated.runContract?.phase, 'planning');
    assert.equal(updated.runContract?.plan?.[0]?.id, 'implementation');
    assert.equal((await loadRunSpec(id))?.status, 'created');
    const records = await listVerificationRecordsForRunSpec(id);
    assert.deepEqual(new Set(records.map(record => record.checkName)), new Set(['pnpm check', 'focused-test']));
    const event = (await listSessionEvents(sessionId)).find(item => item.type === 'run.plan_produced');
    assert.equal(event?.payload?.planStepCount, 1);
    const outbox = await getDb().query<{ count: number }>(
      "SELECT count(*)::int AS count FROM execution_outbox WHERE run_spec_id = $1 AND event_type = 'run.plan_produced'",
      [id],
    );
    assert.equal(outbox.rows[0]?.count, 1);
  } finally {
    await getDb().query('DELETE FROM execution_outbox WHERE run_spec_id = $1', [id]).catch(() => undefined);
    await getDb().query('DELETE FROM session_events WHERE session_id = $1', [sessionId]).catch(() => undefined);
    await getDb().query('DELETE FROM verification_records WHERE run_spec_id = $1', [id]).catch(() => undefined);
    await getDb().query('DELETE FROM run_specs WHERE id = $1', [id]).catch(() => undefined);
    await closeDb().catch(() => undefined);
  }
});

test('persistRunSpecPlan rejects a non-planning run', async () => {
  const config = await loadConfig();
  await initDb(config.databaseUrl);
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const id = `run-not-planning-${suffix}`;
  const sessionId = `session-not-planning-${suffix}`;
  try {
    await createRunSpec({
      id,
      sessionId,
      prompt: 'Do not persist this plan',
      workspaceRoot: process.cwd(),
      toolMode: 'project-write',
      runContract: { mode: 'execution', phase: 'plan_approved' },
    });
    await assert.rejects(persistRunSpecPlan(id, {
      plan: [{
        id: 'step', title: 'Step', description: 'A complete step.', dependsOnIds: [],
        editableSurfaces: [], completionCriteria: 'Done.',
      }],
    }), /requires run phase 'planning'/);
  } finally {
    await getDb().query('DELETE FROM run_specs WHERE id = $1', [id]).catch(() => undefined);
    await closeDb().catch(() => undefined);
  }
});
