import test from 'node:test';
import assert from 'node:assert/strict';

import { loadConfig } from '@los/infra/config';
import { closeDb, getDb, initDb } from '@los/infra/db';
import {
  approveRunSpecPhase,
  createRunSpec,
  ensureRunSpecStore,
  loadRunSpec,
  reviseRunSpecPlan,
} from './run-specs.js';
import { listVerificationRecordsForRunSpec } from './verification-records.js';
import { listSessionEvents } from './session-events.js';

test('run specs persist normalized run contract metadata', async () => {
  const config = await loadConfig();
  await initDb(config.databaseUrl);
  const id = `run-contract-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  try {
    await ensureRunSpecStore();
    const created = await createRunSpec({
      id,
      sessionId: `session-${id}`,
      prompt: 'inspect run contract metadata',
      workspaceRoot: '/tmp/workspace',
      toolMode: 'project-write',
      runContract: {
        mode: 'execution',
        goal: 'persist run spec contract',
        editableSurfaces: ['packages/agent/src/run-specs.ts'],
        requiredChecks: ['pnpm --filter @los/agent test'],
        stopConditions: ['auth mutation'],
        evidenceRequired: ['run_specs row'],
        rawEvidenceProhibited: ['raw transcript'],
      },
    });

    assert.deepEqual(created.runContract, {
      mode: 'execution',
      goal: 'persist run spec contract',
      editableSurfaces: ['packages/agent/src/run-specs.ts'],
      requiredChecks: ['pnpm --filter @los/agent test'],
      allowedSkippedChecks: [],
      stopConditions: ['auth mutation'],
      evidenceRequired: ['run_specs row'],
      externalEvidenceAllowed: [],
      rawEvidenceProhibited: ['raw transcript'],
    });

    const loaded = await loadRunSpec(id);
    assert.equal(loaded?.runContract?.mode, 'execution');
    assert.deepEqual(loaded?.runContract?.evidenceRequired, ['run_specs row']);

    const checks = await listVerificationRecordsForRunSpec(id);
    assert.deepEqual(checks.map((check) => check.checkName), ['pnpm --filter @los/agent test']);
    assert.ok(checks.every((check) => check.status === 'required'));
  } finally {
    await getDb().query('DELETE FROM verification_records WHERE run_spec_id = $1', [id]).catch(() => undefined);
    await getDb().query('DELETE FROM run_specs WHERE id = $1', [id]).catch(() => undefined);
    await closeDb().catch(() => undefined);
  }
});

test('approveRunSpecPhase transitions from planning to plan_approved', async () => {
  const config = await loadConfig();
  await initDb(config.databaseUrl);
  const id = `run-approve-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  try {
    await ensureRunSpecStore();
    await createRunSpec({
      id,
      sessionId: `session-${id}`,
      prompt: 'test approve phase',
      workspaceRoot: '/tmp/workspace',
      toolMode: 'project-write',
      runContract: {
        mode: 'execution',
        goal: 'test approval',
        editableSurfaces: ['src/'],
        phase: 'planning',
      },
    });

    const approved = await approveRunSpecPhase(id, {
      actor: 'test-operator',
      reason: 'plan looks good',
    });

    assert.equal(approved.runContract?.phase, 'plan_approved');
    assert.equal(approved.runContract?.previousPhase, 'planning');
    assert.ok(typeof approved.runContract?.phaseChangedAt === 'string');

    // Verify session event was emitted
    const events = await listSessionEvents(`session-${id}`);
    const approvalEvent = events.find((e) => e.type === 'run.plan_approved');
    assert.ok(approvalEvent, 'run.plan_approved event should be emitted');
    assert.equal(approvalEvent.payload?.actor, 'test-operator');
    assert.equal(approvalEvent.payload?.reason, 'plan looks good');
    assert.equal(approvalEvent.payload?.phase, 'plan_approved');
    assert.equal(approvalEvent.payload?.previousPhase, 'planning');
  } finally {
    await getDb().query('DELETE FROM session_events WHERE session_id = $1', [`session-${id}`]).catch(() => undefined);
    await getDb().query('DELETE FROM verification_records WHERE run_spec_id = $1', [id]).catch(() => undefined);
    await getDb().query('DELETE FROM run_specs WHERE id = $1', [id]).catch(() => undefined);
    await closeDb().catch(() => undefined);
  }
});

test('approveRunSpecPhase rejects invalid phase transition', async () => {
  const config = await loadConfig();
  await initDb(config.databaseUrl);
  const id = `run-approve-fail-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  try {
    await ensureRunSpecStore();
    await createRunSpec({
      id,
      sessionId: `session-${id}`,
      prompt: 'test approve rejection',
      workspaceRoot: '/tmp/workspace',
      toolMode: 'project-write',
      runContract: {
        mode: 'execution',
        goal: 'test invalid approval',
        editableSurfaces: ['src/'],
        phase: 'executing', // Cannot go from executing → plan_approved
      },
    });

    await assert.rejects(
      () => approveRunSpecPhase(id),
      /Illegal phase transition.*executing.*plan_approved/,
    );
  } finally {
    await getDb().query('DELETE FROM session_events WHERE session_id = $1', [`session-${id}`]).catch(() => undefined);
    await getDb().query('DELETE FROM verification_records WHERE run_spec_id = $1', [id]).catch(() => undefined);
    await getDb().query('DELETE FROM run_specs WHERE id = $1', [id]).catch(() => undefined);
    await closeDb().catch(() => undefined);
  }
});

test('approveRunSpecPhase throws for missing run spec', async () => {
  const config = await loadConfig();
  await initDb(config.databaseUrl);
  try {
    await ensureRunSpecStore();
    await assert.rejects(
      () => approveRunSpecPhase('nonexistent-id'),
      /Run spec not found/,
    );
  } finally {
    await closeDb().catch(() => undefined);
  }
});

test('reviseRunSpecPlan increments revision and resets phase to planning', async () => {
  const config = await loadConfig();
  await initDb(config.databaseUrl);
  const id = `run-revise-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  try {
    await ensureRunSpecStore();
    await createRunSpec({
      id,
      sessionId: `session-${id}`,
      prompt: 'test revise plan',
      workspaceRoot: '/tmp/workspace',
      toolMode: 'project-write',
      runContract: {
        mode: 'execution',
        goal: 'original plan',
        editableSurfaces: ['src/'],
        phase: 'plan_approved',
        plan: [{ id: 'step-1', title: 'Original step', description: '', dependsOnIds: [], editableSurfaces: [], completionCriteria: '' }],
        planRevision: 1,
      },
    });

    const revised = await reviseRunSpecPlan(id, {
      plan: [
        { id: 'step-1', title: 'Updated step', description: '', dependsOnIds: [], editableSurfaces: [], completionCriteria: '' },
        { id: 'step-2', title: 'New step', description: '', dependsOnIds: [], editableSurfaces: [], completionCriteria: '' },
      ],
      actor: 'test-operator',
      reason: 'scope increased',
    });

    assert.equal(revised.runContract?.planRevision, 2);
    assert.equal(revised.runContract?.phase, 'planning');
    assert.equal(revised.runContract?.previousPhase, 'plan_approved');
    assert.equal(revised.runContract?.plan?.length, 2);
    assert.equal(revised.runContract?.plan?.[0].title, 'Updated step');

    // Verify plan lineage
    assert.equal(revised.runContract?.planParentRunSpecId, id);

    // Verify session event
    const events = await listSessionEvents(`session-${id}`);
    const revisedEvent = events.find((e) => e.type === 'run.plan_revised');
    assert.ok(revisedEvent, 'run.plan_revised event should be emitted');
    assert.equal(revisedEvent.payload?.planRevision, 2);
    assert.equal(revisedEvent.payload?.previousRevision, 1);
    assert.equal(revisedEvent.payload?.actor, 'test-operator');
    assert.equal(revisedEvent.payload?.reason, 'scope increased');
  } finally {
    await getDb().query('DELETE FROM session_events WHERE session_id = $1', [`session-${id}`]).catch(() => undefined);
    await getDb().query('DELETE FROM verification_records WHERE run_spec_id = $1', [id]).catch(() => undefined);
    await getDb().query('DELETE FROM run_specs WHERE id = $1', [id]).catch(() => undefined);
    await closeDb().catch(() => undefined);
  }
});

test('reviseRunSpecPlan throws for missing run spec', async () => {
  const config = await loadConfig();
  await initDb(config.databaseUrl);
  try {
    await ensureRunSpecStore();
    await assert.rejects(
      () => reviseRunSpecPlan('nonexistent-id'),
      /Run spec not found/,
    );
  } finally {
    await closeDb().catch(() => undefined);
  }
});

test('reviseRunSpecPlan defaults planRevision to 2 when not explicitly set', async () => {
  const config = await loadConfig();
  await initDb(config.databaseUrl);
  const id = `run-revise-default-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  try {
    await ensureRunSpecStore();
    await createRunSpec({
      id,
      sessionId: `session-${id}`,
      prompt: 'test revise without explicit planRevision',
      workspaceRoot: '/tmp/workspace',
      toolMode: 'project-write',
      runContract: {
        mode: 'execution',
        goal: 'no explicit revision',
        editableSurfaces: ['src/'],
        phase: 'planning',
        // planRevision not set — defaults to 1 in reviseRunSpecPlan
      },
    });

    const revised = await reviseRunSpecPlan(id, {
      reason: 'initial revision',
    });

    assert.equal(revised.runContract?.planRevision, 2);
    assert.equal(revised.runContract?.phase, 'planning');
    assert.equal(revised.runContract?.planParentRunSpecId, id);
  } finally {
    await getDb().query('DELETE FROM session_events WHERE session_id = $1', [`session-${id}`]).catch(() => undefined);
    await getDb().query('DELETE FROM verification_records WHERE run_spec_id = $1', [id]).catch(() => undefined);
    await getDb().query('DELETE FROM run_specs WHERE id = $1', [id]).catch(() => undefined);
    await closeDb().catch(() => undefined);
  }
});
