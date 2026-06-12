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
} from '@los/agent';
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

    await createRunSpec({
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
      },
    });

    const res = await app.inject({
      method: 'POST',
      url: `/runs/${runSpecId}/approve`,
      payload: {
        actor: 'gateway-tester',
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
    assert.equal(approvalEvent.payload?.actor, 'gateway-tester');
    assert.equal(approvalEvent.payload?.reason, 'approved via integration test');
  } finally {
    await app.close();
    await getDb().query('DELETE FROM session_events WHERE session_id = $1', [sessionId]).catch(() => undefined);
    await getDb().query('DELETE FROM verification_records WHERE run_spec_id = $1', [runSpecId]).catch(() => undefined);
    await getDb().query('DELETE FROM run_specs WHERE id = $1', [runSpecId]).catch(() => undefined);
    await closeDb().catch(() => undefined);
  }
});

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
        plan: [{ id: 'step-1', title: 'Original', description: '', dependsOnIds: [], editableSurfaces: [], completionCriteria: '' }],
        planRevision: 1,
      },
    });

    const res = await app.inject({
      method: 'POST',
      url: `/runs/${runSpecId}/revise-plan`,
      payload: {
        plan: [
          { id: 'step-1', title: 'Updated', description: '', dependsOnIds: [], editableSurfaces: [], completionCriteria: '' },
          { id: 'step-2', title: 'New step', description: '', dependsOnIds: [], editableSurfaces: [], completionCriteria: '' },
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
    assert.equal(loaded?.runContract?.planParentRunSpecId, runSpecId);

    // Verify session event
    const events = await listSessionEvents(sessionId);
    const revisedEvent = events.find((e) => e.type === 'run.plan_revised');
    assert.ok(revisedEvent, 'run.plan_revised event should be emitted');
    assert.equal(revisedEvent.payload?.planRevision, 2);
    assert.equal(revisedEvent.payload?.previousRevision, 1);
    assert.equal(revisedEvent.payload?.actor, 'gateway-tester');
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
