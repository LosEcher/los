import test from 'node:test';
import assert from 'node:assert/strict';

import { loadConfig } from '@los/infra/config';
import { closeDb, getDb, initDb } from '@los/infra/db';
import {
  appendSessionEvent,
  createRunSpec,
  ensureRunSpecStore,
  ensureSessionEventStore,
  listSessionEvents,
  loadRunSpec,
  reviseRunSpecPlan,
} from '@los/agent';
import { projectWorkItemAvailableActions } from '@los/agent/work-items';
import { createServer } from '../server.js';

test('POST /runs/:id/approve approves plan_approved transition', async () => {
  const config = await loadConfig();
  await initDb(config.databaseUrl);

  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const runSpecId = `run-approve-gw-${suffix}`;
  const sessionId = `session-approve-gw-${suffix}`;
  const app = await createServer({
    serviceId: `gateway-approve-test-${suffix}`,
    bindUrl: 'http://127.0.0.1:0',
    publicUrl: 'http://127.0.0.1:0',
    hostLabel: 'test',
  });

  try {
    await ensureRunSpecStore();
    await ensureSessionEventStore();

    const created = await createRunSpec({
      id: runSpecId,
      sessionId,
      prompt: 'gateway approve test',
      workspaceRoot: process.cwd(),
      toolMode: 'project-write',
      runContract: {
        mode: 'execution',
        goal: 'test approval via gateway',
        editableSurfaces: ['src/'],
        phase: 'planning',
        requiredChecks: ['pnpm check'],
        plan: [{
          id: 'step-1',
          title: 'Approve gateway plan',
          description: 'Exercise the gateway approval path.',
          dependsOnIds: [],
          editableSurfaces: ['src/'],
          completionCriteria: 'The plan is approved and persisted.',
        }],
      },
    });

    const invalidCapability = await app.inject({
      method: 'POST',
      url: `/runs/${runSpecId}/approve`,
      payload: { planRevision: 0, reason: 'invalid browser approval' },
    });
    assert.equal(invalidCapability.statusCode, 400);
    assert.equal(invalidCapability.json().error, 'invalid_request');

    const staleCapability = approvalCapability(runSpecId, created.runContract!);
    await reviseRunSpecPlan(runSpecId, {
      actor: 'gateway-tester',
      reason: 'clarify the completion evidence',
      plan: [{
        id: 'step-1',
        title: 'Approve revised gateway plan',
        description: 'Exercise stale capability rejection before approval.',
        dependsOnIds: [],
        editableSurfaces: ['src/'],
        completionCriteria: 'The stale capability is rejected and the current plan is approved.',
      }],
    });

    const stale = await app.inject({
      method: 'POST',
      url: `/runs/${runSpecId}/approve`,
      payload: { ...staleCapability, reason: 'stale browser approval' },
    });
    assert.equal(stale.statusCode, 409);
    assert.equal(stale.json().error, 'approval_capability_stale');

    const revised = await loadRunSpec(runSpecId);
    const currentCapability = approvalCapability(runSpecId, revised!.runContract!);

    const res = await app.inject({
      method: 'POST',
      url: `/runs/${runSpecId}/approve`,
      payload: {
        ...currentCapability,
        reason: 'approved via integration test',
      },
    });

    assert.equal(res.statusCode, 200);
    const body = res.json<{ phase?: string; previousPhase?: string }>();
    assert.equal(body.phase, 'plan_approved');
    assert.equal(body.previousPhase, 'planning');

    // Verify persisted state
    const loaded = await loadRunSpec(runSpecId);
    assert.equal(loaded?.runContract?.phase, 'plan_approved');

    // Verify session event emitted
    const events = await listSessionEvents(sessionId);
    const approvalEvent = events.find((e) => e.type === 'run.plan_approved');
    assert.ok(approvalEvent, 'run.plan_approved event should be emitted');
    assert.equal(approvalEvent.payload?.actor, 'operator:local');
    assert.equal(approvalEvent.payload?.reason, 'approved via integration test');
  } finally {
    await app.close();
    await getDb().query('DELETE FROM session_events WHERE session_id = $1', [sessionId]).catch(() => undefined);
    await getDb().query('DELETE FROM verification_records WHERE run_spec_id = $1', [runSpecId]).catch(() => undefined);
    await getDb().query('DELETE FROM run_specs WHERE id = $1', [runSpecId]).catch(() => undefined);
    await closeDb().catch(() => undefined);
  }
});

function approvalCapability(runSpecId: string, contract: NonNullable<Awaited<ReturnType<typeof createRunSpec>>['runContract']>) {
  return projectWorkItemAvailableActions({
    workItemId: 'work-item-gateway-approval-test',
    nextAction: 'review_plan',
    runSpecId,
    contract,
  }).approvePlan!.payload;
}

test('POST /runs/:id/approve rejects invalid phase transition', async () => {
  const config = await loadConfig();
  await initDb(config.databaseUrl);

  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const runSpecId = `run-approve-gw-fail-${suffix}`;
  const sessionId = `session-approve-gw-fail-${suffix}`;
  const app = await createServer({
    serviceId: `gateway-approve-fail-${suffix}`,
    bindUrl: 'http://127.0.0.1:0',
    publicUrl: 'http://127.0.0.1:0',
    hostLabel: 'test',
  });

  try {
    await ensureRunSpecStore();
    await ensureSessionEventStore();

    await createRunSpec({
      id: runSpecId,
      sessionId,
      prompt: 'gateway approve fail test',
      workspaceRoot: process.cwd(),
      toolMode: 'project-write',
      runContract: {
        mode: 'execution',
        goal: 'test invalid approval',
        editableSurfaces: ['src/'],
        phase: 'executing', // Cannot go from executing → plan_approved
      },
    });

    const res = await app.inject({
      method: 'POST',
      url: `/runs/${runSpecId}/approve`,
      payload: {
        actor: 'gateway-tester',
        reason: 'this should fail',
      },
    });

    assert.equal(res.statusCode, 400);
    const body = res.json<{ error?: string; message?: string }>();
    assert.ok(body.error || body.message, 'should return error for invalid transition');
  } finally {
    await app.close();
    await getDb().query('DELETE FROM session_events WHERE session_id = $1', [sessionId]).catch(() => undefined);
    await getDb().query('DELETE FROM verification_records WHERE run_spec_id = $1', [runSpecId]).catch(() => undefined);
    await getDb().query('DELETE FROM run_specs WHERE id = $1', [runSpecId]).catch(() => undefined);
    await closeDb().catch(() => undefined);
  }
});

test('POST /runs/:id/approve returns 404 for nonexistent run spec', async () => {
  const config = await loadConfig();
  await initDb(config.databaseUrl);

  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const app = await createServer({
    serviceId: `gateway-approve-404-${suffix}`,
    bindUrl: 'http://127.0.0.1:0',
    publicUrl: 'http://127.0.0.1:0',
    hostLabel: 'test',
  });

  try {
    await ensureRunSpecStore();
    const res = await app.inject({
      method: 'POST',
      url: '/runs/nonexistent-id/approve',
      payload: { reason: 'no such run' },
    });

    assert.equal(res.statusCode, 404);
  } finally {
    await app.close();
    await closeDb().catch(() => undefined);
  }
});

test('POST /runs/:id/revise-plan increments revision and resets phase', async () => {
  const config = await loadConfig();
  await initDb(config.databaseUrl);

  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const runSpecId = `run-revise-gw-${suffix}`;
  const sessionId = `session-revise-gw-${suffix}`;
  const app = await createServer({
    serviceId: `gateway-revise-test-${suffix}`,
    bindUrl: 'http://127.0.0.1:0',
    publicUrl: 'http://127.0.0.1:0',
    hostLabel: 'test',
  });

  try {
    await ensureRunSpecStore();
    await ensureSessionEventStore();

    await createRunSpec({
      id: runSpecId,
      sessionId,
      prompt: 'gateway revise plan test',
      workspaceRoot: process.cwd(),
      toolMode: 'project-write',
      runContract: {
        mode: 'execution',
        goal: 'original plan',
        editableSurfaces: ['src/'],
        phase: 'plan_approved',
        requiredChecks: ['pnpm check'],
        plan: [{ id: 'step-1', title: 'Original', description: 'Original plan.', dependsOnIds: [], editableSurfaces: [], completionCriteria: 'Original plan completes.' }],
        planRevision: 1,
      },
    });

    const res = await app.inject({
      method: 'POST',
      url: `/runs/${runSpecId}/revise-plan`,
      payload: {
        plan: [
          { id: 'step-1', title: 'Updated', description: 'Updated plan.', dependsOnIds: [], editableSurfaces: [], completionCriteria: 'Updated plan completes.' },
          { id: 'step-2', title: 'New step', description: 'Expanded scope.', dependsOnIds: ['step-1'], editableSurfaces: [], completionCriteria: 'Expanded scope completes.' },
        ],
        actor: 'gateway-tester',
        reason: 'scope increased',
      },
    });

    assert.equal(res.statusCode, 200);
    const body = res.json<{ planRevision?: number; previousRevision?: number; phase?: string; previousPhase?: string }>();
    assert.equal(body.planRevision, 2);
    assert.equal(body.previousRevision, 1);
    assert.equal(body.phase, 'planning');
    assert.equal(body.previousPhase, 'plan_approved');

    // Verify persisted state
    const loaded = await loadRunSpec(runSpecId);
    assert.equal(loaded?.runContract?.planRevision, 2);
    assert.equal(loaded?.runContract?.phase, 'planning');
    assert.equal(loaded?.runContract?.planParentRunSpecId, undefined);
    assert.equal(loaded?.runContract?.planParentRevision, 1);

    // Verify session event
    const events = await listSessionEvents(sessionId);
    const revisedEvent = events.find((e) => e.type === 'run.plan_revised');
    assert.ok(revisedEvent, 'run.plan_revised event should be emitted');
    assert.equal(revisedEvent.payload?.planRevision, 2);
    assert.equal(revisedEvent.payload?.previousRevision, 1);
    assert.equal(revisedEvent.payload?.actor, 'operator:local');
  } finally {
    await app.close();
    await getDb().query('DELETE FROM session_events WHERE session_id = $1', [sessionId]).catch(() => undefined);
    await getDb().query('DELETE FROM verification_records WHERE run_spec_id = $1', [runSpecId]).catch(() => undefined);
    await getDb().query('DELETE FROM run_specs WHERE id = $1', [runSpecId]).catch(() => undefined);
    await closeDb().catch(() => undefined);
  }
});

test('POST /runs/:id/revise-plan returns 404 for nonexistent run spec', async () => {
  const config = await loadConfig();
  await initDb(config.databaseUrl);

  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const app = await createServer({
    serviceId: `gateway-revise-404-${suffix}`,
    bindUrl: 'http://127.0.0.1:0',
    publicUrl: 'http://127.0.0.1:0',
    hostLabel: 'test',
  });

  try {
    await ensureRunSpecStore();
    const res = await app.inject({
      method: 'POST',
      url: '/runs/nonexistent-id/revise-plan',
      payload: { reason: 'no such run' },
    });

    assert.equal(res.statusCode, 404);
  } finally {
    await app.close();
    await closeDb().catch(() => undefined);
  }
});

test('POST /runs/:id/approve does not auto-dispatch K4 kernel candidate runs', async () => {
  const config = await loadConfig();
  await initDb(config.databaseUrl);

  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const runSpecId = `run-approve-k4-${suffix}`;
  const sessionId = `session-approve-k4-${suffix}`;
  const app = await createServer({
    serviceId: `gateway-approve-k4-${suffix}`,
    bindUrl: 'http://127.0.0.1:0',
    publicUrl: 'http://127.0.0.1:0',
    hostLabel: 'test',
  });

  try {
    await ensureRunSpecStore();
    await ensureSessionEventStore();

    const { createK4ExecutionKernelSelection } = await import('@los/agent');
    await createRunSpec({
      id: runSpecId,
      sessionId,
      prompt: 'K4 candidate approve test',
      workspaceRoot: process.cwd(),
      toolMode: 'read-only',
      runContract: {
        mode: 'audit',
        goal: 'test K4 candidate approval without auto-dispatch',
        editableSurfaces: ['docs/'],
        phase: 'planning',
        plan: [{
          id: 'step-1',
          title: 'Approve K4 candidate plan',
          description: 'Exercise the K4 approval path; dispatch must stay with the execute endpoint.',
          dependsOnIds: [],
          editableSurfaces: ['docs/'],
          completionCriteria: 'The K4 candidate plan is approved and not auto-dispatched.',
        }],
        verifications: [{
          id: 'v1',
          kind: 'command',
          description: 'queue document exists',
          command: 'test -f docs/governance/2026-07-16-current-p0-p1-queue.md',
        }],
        executionKernel: createK4ExecutionKernelSelection({
          experimentId: 'experiment-k4-approve-test',
          disposition: 'planning',
          actor: 'operator:select',
        }),
      },
    });

    const response = await app.inject({
      method: 'POST',
      url: `/runs/${runSpecId}/approve`,
      payload: { reason: 'approve K4 candidate plan (no auto dispatch)' },
    });
    assert.equal(response.statusCode, 200);
    const body = response.json();
    assert.equal(body.phase, 'plan_approved');
    // K4 candidate runs are executed through the experiment execute endpoint;
    // approving the plan must not schedule an execution dispatch.
    assert.equal(body.dispatch, undefined);
  } finally {
    await app.close();
    await closeDb().catch(() => undefined);
  }
});
