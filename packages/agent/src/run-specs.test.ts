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
import { transitionExecutionState } from './execution-store.js';
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
        verifications: [{
          id: 'operator-review',
          kind: 'operator_review',
          description: 'Operator confirms the persisted contract.',
          reviewer: 'test-operator',
        }],
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
      verifications: [{
        id: 'operator-review',
        kind: 'operator_review',
        description: 'Operator confirms the persisted contract.',
        command: undefined,
        assertion: undefined,
        reviewer: 'test-operator',
      }],
    });

    const loaded = await loadRunSpec(id);
    assert.equal(loaded?.runContract?.mode, 'execution');
    assert.deepEqual(loaded?.runContract?.evidenceRequired, ['run_specs row']);

    const checks = await listVerificationRecordsForRunSpec(id);
    assert.deepEqual(checks.map((check) => check.checkName), ['pnpm --filter @los/agent test', 'operator-review']);
    assert.ok(checks.every((check) => check.status === 'required'));
  } finally {
    await getDb().query('DELETE FROM verification_records WHERE run_spec_id = $1', [id]).catch(() => undefined);
    await getDb().query('DELETE FROM run_specs WHERE id = $1', [id]).catch(() => undefined);
    await closeDb().catch(() => undefined);
  }
});

test('run_specs status constraint rejects invalid raw database writes', async () => {
  const config = await loadConfig();
  await initDb(config.databaseUrl);
  const id = `run-invalid-status-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  try {
    await ensureRunSpecStore();
    await assert.rejects(
      () => getDb().query(
        `
        INSERT INTO run_specs (
          id, session_id, prompt, workspace_root, tool_mode,
          model_settings_json, allowed_tools_json, tool_retry_json,
          max_loops, mcp_servers_json, run_contract_json, status
        )
        VALUES (
          $1, $2, 'invalid status', '/tmp/workspace', 'project-write',
          '{}'::jsonb, '[]'::jsonb, '{}'::jsonb,
          20, '[]'::jsonb, '{}'::jsonb, 'deepseek-reasoner'
        )
      `,
        [id, `session-${id}`],
      ),
      /run_specs_status_chk/,
    );
  } finally {
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
        requiredChecks: ['pnpm check'],
        plan: [{
          id: 'step-1',
          title: 'Approve the plan',
          description: 'Persist a complete plan before approval.',
          dependsOnIds: [],
          editableSurfaces: ['src/'],
          completionCriteria: 'The approved contract contains this step.',
        }],
      },
    });
    await getDb().query(
      `UPDATE run_specs
       SET run_contract_json = jsonb_set(
         run_contract_json || '{"futureApprovalField":"keep"}'::jsonb,
         '{plan,0,futureStepField}',
         '"keep-nested"'::jsonb
       )
       WHERE id = $1`,
      [id],
    );

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
    const approvalOutbox = await getDb().query<{ count: number }>(
      `SELECT count(*)::int AS count FROM execution_outbox WHERE run_spec_id = $1 AND event_type = 'run.plan_approved'`,
      [id],
    );
    assert.equal(approvalOutbox.rows[0]?.count, 1);
    const raw = await getDb().query<{ future_field: string; future_step_field: string }>(
      `SELECT run_contract_json->>'futureApprovalField' AS future_field,
              run_contract_json #>> '{plan,0,futureStepField}' AS future_step_field
       FROM run_specs WHERE id = $1`,
      [id],
    );
    assert.equal(raw.rows[0]?.future_field, 'keep');
    assert.equal(raw.rows[0]?.future_step_field, 'keep-nested');
  } finally {
    await getDb().query('DELETE FROM execution_outbox WHERE run_spec_id = $1', [id]).catch(() => undefined);
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

test('approveRunSpecPhase rejects standard execution without a structured plan', async () => {
  const config = await loadConfig();
  await initDb(config.databaseUrl);
  const id = `run-approve-empty-plan-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  try {
    await createRunSpec({
      id,
      sessionId: `session-${id}`,
      prompt: 'reject empty plan approval',
      workspaceRoot: '/tmp/workspace',
      toolMode: 'project-write',
      runContract: { mode: 'execution', phase: 'planning', editableSurfaces: ['src/'] },
    });

    await assert.rejects(
      () => approveRunSpecPhase(id),
      /requires at least one structured plan step/,
    );
    assert.equal((await loadRunSpec(id))?.runContract?.phase, 'planning');
    assert.equal((await listSessionEvents(`session-${id}`)).some((event) => event.type === 'run.plan_approved'), false);
  } finally {
    await getDb().query('DELETE FROM session_events WHERE session_id = $1', [`session-${id}`]).catch(() => undefined);
    await getDb().query('DELETE FROM verification_records WHERE run_spec_id = $1', [id]).catch(() => undefined);
    await getDb().query('DELETE FROM run_specs WHERE id = $1', [id]).catch(() => undefined);
    await closeDb().catch(() => undefined);
  }
});

test('approveRunSpecPhase serializes concurrent approvals', async () => {
  const config = await loadConfig();
  await initDb(config.databaseUrl);
  const id = `run-approve-concurrent-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const sessionId = `session-${id}`;
  try {
    await createRunSpec({
      id,
      sessionId,
      prompt: 'serialize concurrent plan approvals',
      workspaceRoot: '/tmp/workspace',
      toolMode: 'project-write',
      runContract: {
        mode: 'execution',
        phase: 'planning',
        editableSurfaces: ['src/'],
        requiredChecks: ['pnpm check'],
        plan: [{
          id: 'step-1',
          title: 'Serialize approval',
          description: 'Lock the run spec while approving its persisted plan.',
          dependsOnIds: [],
          editableSurfaces: ['src/'],
          completionCriteria: 'Exactly one approval transaction succeeds.',
        }],
      },
    });

    const results = await Promise.allSettled([
      approveRunSpecPhase(id, { actor: 'operator-a' }),
      approveRunSpecPhase(id, { actor: 'operator-b' }),
    ]);
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
    assert.equal(results.filter((result) => result.status === 'rejected').length, 1);
    assert.equal((await loadRunSpec(id))?.runContract?.phase, 'plan_approved');
    const events = await listSessionEvents(sessionId);
    assert.equal(events.filter((event) => event.type === 'run.plan_approved').length, 1);
  } finally {
    await getDb().query('DELETE FROM session_events WHERE session_id = $1', [sessionId]).catch(() => undefined);
    await getDb().query('DELETE FROM verification_records WHERE run_spec_id = $1', [id]).catch(() => undefined);
    await getDb().query('DELETE FROM run_specs WHERE id = $1', [id]).catch(() => undefined);
    await closeDb().catch(() => undefined);
  }
});

test('approveRunSpecPhase rejects standard execution without verification mapping', async () => {
  const config = await loadConfig();
  await initDb(config.databaseUrl);
  const id = `run-approve-no-verification-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const sessionId = `session-${id}`;
  try {
    await createRunSpec({
      id,
      sessionId,
      prompt: 'reject approval without verification mapping',
      workspaceRoot: '/tmp/workspace',
      toolMode: 'project-write',
      runContract: {
        mode: 'execution',
        phase: 'planning',
        editableSurfaces: ['src/'],
        plan: [{
          id: 'step-1',
          title: 'Implement change',
          description: 'Implement the planned change.',
          dependsOnIds: [],
          editableSurfaces: ['src/'],
          completionCriteria: 'The implementation is complete.',
        }],
      },
    });

    await assert.rejects(
      () => approveRunSpecPhase(id),
      /requires at least one required check or verification requirement/,
    );
    assert.equal((await loadRunSpec(id))?.runContract?.phase, 'planning');
    assert.equal((await listSessionEvents(sessionId)).some((event) => event.type === 'run.plan_approved'), false);
  } finally {
    await getDb().query('DELETE FROM session_events WHERE session_id = $1', [sessionId]).catch(() => undefined);
    await getDb().query('DELETE FROM verification_records WHERE run_spec_id = $1', [id]).catch(() => undefined);
    await getDb().query('DELETE FROM run_specs WHERE id = $1', [id]).catch(() => undefined);
    await closeDb().catch(() => undefined);
  }
});

test('approveRunSpecPhase rejects structured verification without a completion pathway', async () => {
  const config = await loadConfig();
  await initDb(config.databaseUrl);
  const id = `run-approve-structured-verification-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const sessionId = `session-${id}`;
  try {
    await createRunSpec({
      id,
      sessionId,
      prompt: 'reject unsupported structured verification approval',
      workspaceRoot: '/tmp/workspace',
      toolMode: 'project-write',
      runContract: {
        mode: 'execution',
        phase: 'planning',
        editableSurfaces: ['src/'],
        plan: [{
          id: 'step-1',
          title: 'Review result',
          description: 'Require an operator review.',
          dependsOnIds: [],
          editableSurfaces: ['src/'],
          completionCriteria: 'The operator accepts the result.',
        }],
        verifications: [{
          id: 'operator-review',
          kind: 'operator_review',
          description: 'Operator accepts the result.',
          reviewer: 'operator',
        }],
      },
    });

    await assert.rejects(
      () => approveRunSpecPhase(id),
      /uses unsupported approval kind 'operator_review'/,
    );
    assert.equal((await loadRunSpec(id))?.runContract?.phase, 'planning');
    assert.equal((await listSessionEvents(sessionId)).some((event) => event.type === 'run.plan_approved'), false);
  } finally {
    await getDb().query('DELETE FROM session_events WHERE session_id = $1', [sessionId]).catch(() => undefined);
    await getDb().query('DELETE FROM verification_records WHERE run_spec_id = $1', [id]).catch(() => undefined);
    await getDb().query('DELETE FROM run_specs WHERE id = $1', [id]).catch(() => undefined);
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
        requiredChecks: ['pnpm check'],
        plan: [{ id: 'step-1', title: 'Original step', description: 'Original work.', dependsOnIds: [], editableSurfaces: [], completionCriteria: 'Original work is complete.' }],
        planRevision: 1,
      },
    });
    await getDb().query(
      `UPDATE run_specs
       SET run_contract_json = jsonb_set(
         run_contract_json || '{"futureFlag":"preserve-me"}'::jsonb,
         '{plan,0,futureStepField}',
         '"preserve-in-history"'::jsonb
       )
       WHERE id = $1`,
      [id],
    );
    const [oldVerification] = await listVerificationRecordsForRunSpec(id);
    assert.ok(oldVerification);
    await transitionExecutionState({ entityType: 'verification_record', entityId: oldVerification.id, to: 'running', reason: 'old_check_started' });
    await transitionExecutionState({ entityType: 'verification_record', entityId: oldVerification.id, to: 'succeeded', reason: 'old_check_passed' });

    const revised = await reviseRunSpecPlan(id, {
      plan: [
        { id: 'step-1', title: 'Updated step', description: 'Update the original work.', dependsOnIds: [], editableSurfaces: [], completionCriteria: 'Updated work is complete.' },
        { id: 'step-2', title: 'New step', description: 'Complete the expanded scope.', dependsOnIds: ['step-1'], editableSurfaces: [], completionCriteria: 'Expanded scope is complete.' },
      ],
      actor: 'test-operator',
      reason: 'scope increased',
    });

    assert.equal(revised.runContract?.planRevision, 2);
    assert.equal(revised.runContract?.phase, 'planning');
    assert.equal(revised.runContract?.previousPhase, 'plan_approved');
    assert.equal(revised.runContract?.plan?.length, 2);
    assert.equal(revised.runContract?.plan?.[0].title, 'Updated step');
    assert.equal(revised.runContract?.planParentRevision, 1);
    assert.equal(revised.runContract?.planHistory?.[0]?.revision, 1);
    assert.equal(revised.runContract?.planHistory?.[0]?.plan[0]?.title, 'Original step');

    const verificationRecords = await listVerificationRecordsForRunSpec(id);
    assert.equal(verificationRecords.length, 2);
    assert.equal(verificationRecords[0]?.planRevision, 1);
    assert.equal(verificationRecords[0]?.required, false);
    assert.equal(verificationRecords[0]?.status, 'succeeded');
    assert.equal(verificationRecords[1]?.planRevision, 2);
    assert.equal(verificationRecords[1]?.required, true);
    assert.equal(verificationRecords[1]?.status, 'required');
    const raw = await getDb().query<{ future_flag: string; history_step_field: string }>(
      `SELECT run_contract_json->>'futureFlag' AS future_flag,
              run_contract_json #>> '{planHistory,0,plan,0,futureStepField}' AS history_step_field
       FROM run_specs WHERE id = $1`,
      [id],
    );
    assert.equal(raw.rows[0]?.future_flag, 'preserve-me');
    assert.equal(raw.rows[0]?.history_step_field, 'preserve-in-history');

    // Verify plan lineage
    assert.equal(revised.runContract?.planParentRunSpecId, undefined);

    // Verify session event
    const events = await listSessionEvents(`session-${id}`);
    const revisedEvent = events.find((e) => e.type === 'run.plan_revised');
    assert.ok(revisedEvent, 'run.plan_revised event should be emitted');
    assert.equal(revisedEvent.payload?.planRevision, 2);
    assert.equal(revisedEvent.payload?.previousRevision, 1);
    assert.equal(revisedEvent.payload?.actor, 'test-operator');
    assert.equal(revisedEvent.payload?.reason, 'scope increased');
    const revisionOutbox = await getDb().query<{ count: number }>(
      `SELECT count(*)::int AS count FROM execution_outbox WHERE run_spec_id = $1 AND event_type = 'run.plan_revised'`,
      [id],
    );
    assert.equal(revisionOutbox.rows[0]?.count, 1);
  } finally {
    await getDb().query('DELETE FROM execution_outbox WHERE run_spec_id = $1', [id]).catch(() => undefined);
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

test('reviseRunSpecPlan rejects a missing replacement plan', async () => {
  const config = await loadConfig();
  await initDb(config.databaseUrl);
  const id = `run-revise-empty-plan-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  try {
    await createRunSpec({
      id,
      sessionId: `session-${id}`,
      prompt: 'reject missing revised plan',
      workspaceRoot: '/tmp/workspace',
      toolMode: 'project-write',
      runContract: {
        mode: 'execution',
        phase: 'plan_approved',
        editableSurfaces: ['src/'],
        plan: [{
          id: 'step-1',
          title: 'Existing plan',
          description: 'This plan must not be silently reused.',
          dependsOnIds: [],
          editableSurfaces: [],
          completionCriteria: 'A replacement plan is supplied.',
        }],
      },
    });

    await assert.rejects(
      () => reviseRunSpecPlan(id, { reason: 'needs changes' }),
      /requires at least one structured plan step/,
    );
    assert.equal((await loadRunSpec(id))?.runContract?.phase, 'plan_approved');
  } finally {
    await getDb().query('DELETE FROM session_events WHERE session_id = $1', [`session-${id}`]).catch(() => undefined);
    await getDb().query('DELETE FROM verification_records WHERE run_spec_id = $1', [id]).catch(() => undefined);
    await getDb().query('DELETE FROM run_specs WHERE id = $1', [id]).catch(() => undefined);
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
      plan: [{
        id: 'step-1',
        title: 'Create initial revision',
        description: 'Persist the first explicit plan revision.',
        dependsOnIds: [],
        editableSurfaces: [],
        completionCriteria: 'The revision contains a structured plan.',
      }],
      reason: 'initial revision',
    });

    assert.equal(revised.runContract?.planRevision, 2);
    assert.equal(revised.runContract?.phase, 'planning');
    assert.equal(revised.runContract?.planParentRunSpecId, undefined);
    assert.equal(revised.runContract?.planParentRevision, 1);
  } finally {
    await getDb().query('DELETE FROM session_events WHERE session_id = $1', [`session-${id}`]).catch(() => undefined);
    await getDb().query('DELETE FROM verification_records WHERE run_spec_id = $1', [id]).catch(() => undefined);
    await getDb().query('DELETE FROM run_specs WHERE id = $1', [id]).catch(() => undefined);
    await closeDb().catch(() => undefined);
  }
});

test('reviseRunSpecPlan rejects revisions while execution is active or terminal', async () => {
  const config = await loadConfig();
  await initDb(config.databaseUrl);
  const replacementPlan = [{
    id: 'step-1',
    title: 'Replacement step',
    description: 'Replace the active plan.',
    dependsOnIds: [],
    editableSurfaces: ['src/'],
    completionCriteria: 'The replacement plan is persisted.',
  }];
  try {
    for (const phase of ['executing', 'succeeded'] as const) {
      const id = `run-revise-${phase}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
      const sessionId = `session-${id}`;
      await createRunSpec({
        id,
        sessionId,
        prompt: `reject revision from ${phase}`,
        workspaceRoot: '/tmp/workspace',
        toolMode: 'project-write',
        runContract: {
          mode: 'execution',
          phase,
          editableSurfaces: ['src/'],
          requiredChecks: ['pnpm check'],
          plan: replacementPlan,
        },
      });

      await assert.rejects(
        () => reviseRunSpecPlan(id, { plan: replacementPlan }),
        new RegExp(`not allowed from phase '${phase}'`),
      );
      assert.equal((await loadRunSpec(id))?.runContract?.phase, phase);
      assert.equal((await listSessionEvents(sessionId)).some((event) => event.type === 'run.plan_revised'), false);
      await getDb().query('DELETE FROM session_events WHERE session_id = $1', [sessionId]).catch(() => undefined);
      await getDb().query('DELETE FROM verification_records WHERE run_spec_id = $1', [id]).catch(() => undefined);
      await getDb().query('DELETE FROM run_specs WHERE id = $1', [id]).catch(() => undefined);
    }
  } finally {
    await closeDb().catch(() => undefined);
  }
});
