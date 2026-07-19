import assert from 'node:assert/strict';
import test from 'node:test';

import Fastify from 'fastify';
import { getConfig } from '@los/infra/config';
import { getDb } from '@los/infra/db';

import { registerRequestContext } from './request-context.js';
import { registerWorkItemRoutes } from './routes/data/work-item-routes.js';

test('work item routes create and read a structured draft without dispatching', async () => {
  const app = Fastify({ logger: false });
  registerRequestContext(app, getConfig());
  registerWorkItemRoutes(app);
  let workItemId: string | undefined;
  try {
    const create = await app.inject({
      method: 'POST',
      url: '/work-items',
      headers: {
        'x-tenant-id': 'local',
        'x-project-id': 'los',
        'x-user-id': 'web-test',
      },
      payload: {
        projectId: 'los',
        goal: 'Exercise the Work Item HTTP contract',
        mode: 'execution',
        editableSurfaces: ['packages/gateway/src/routes/data/work-item-routes.ts'],
        requiredChecks: ['pnpm --filter @los/gateway test'],
        stopConditions: ['execution starts'],
        evidenceRequired: ['route response'],
        toolMode: 'project-write',
        priority: 'P1',
      },
    });
    assert.equal(create.statusCode, 201);
    const created = create.json();
    workItemId = created.id;
    assert.equal(created.status, 'backlog');
    assert.equal(created.nextAction, 'start');
    assert.equal(created.runContractDraft.phase, 'created');
    assert.equal(created.evidence.latestRunSpecId, undefined);
    assert.equal(created.evidence.latestTaskRunId, undefined);
    assert.deepEqual(created.verificationRecords, []);
    assert.deepEqual(created.changes.workspaces, []);

    const detail = await app.inject({ method: 'GET', url: `/work-items/${workItemId}` });
    assert.equal(detail.statusCode, 200);
    assert.equal(detail.json().id, workItemId);

    const list = await app.inject({ method: 'GET', url: '/work-items?projectId=los' });
    assert.equal(list.statusCode, 200);
    assert.ok(list.json().results.some((item: { id: string }) => item.id === workItemId));

    const coverage = await app.inject({ method: 'GET', url: '/work-items/verification-coverage?projectId=los&mode=execution' });
    assert.equal(coverage.statusCode, 200);
    assert.equal(coverage.json().mode, 'execution');
    assert.ok(coverage.json().workItems >= 1);

    const prematureAcceptance = await app.inject({
      method: 'POST',
      url: `/work-items/${workItemId}/result-decision`,
      payload: { decision: 'accepted', reason: 'reviewed from route test' },
    });
    assert.equal(prematureAcceptance.statusCode, 409);
    assert.equal(prematureAcceptance.json().error, 'run_not_succeeded');

    const revision = await app.inject({
      method: 'POST',
      url: `/work-items/${workItemId}/result-decision`,
      payload: {
        decision: 'revision_requested',
        reason: 'Add focused evidence',
        closeoutReport: { checks: ['pnpm --filter @los/gateway test'], residualRisk: 'awaiting revision' },
      },
    });
    assert.equal(revision.statusCode, 200);
    assert.equal(revision.json().status, 'in_progress');
    assert.equal(revision.json().changes.resultReview.decision, 'revision_requested');
    assert.deepEqual(revision.json().changes.resultReview.closeoutReport.checks, ['pnpm --filter @los/gateway test']);
  } finally {
    if (workItemId) await getDb().query('DELETE FROM todos WHERE id = $1', [workItemId]);
    await app.close();
  }
});

test('work item creation rejects missing contract arrays', async () => {
  const app = Fastify({ logger: false });
  registerRequestContext(app, getConfig());
  registerWorkItemRoutes(app);
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/work-items',
      payload: { projectId: 'los', goal: 'invalid draft', mode: 'audit' },
    });
    assert.equal(response.statusCode, 400);
    assert.deepEqual(response.json(), {
      error: 'invalid_request',
      message: 'editableSurfaces must be an array',
    });
  } finally {
    await app.close();
  }
});
