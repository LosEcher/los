import assert from 'node:assert/strict';
import test from 'node:test';

import Fastify from 'fastify';
import { loadConfig } from '@los/infra/config';

import { registerRequestContext } from './request-context.js';
import { registerWorkItemRoutes } from './routes/data/work-item-routes.js';
import type { WorkItemRouteDependencies } from './routes/data/work-item-routes.js';
import type { WorkItemProjection } from '@los/agent/work-items';
import type { WorkItemVerificationCoverage } from '@los/agent/work-items';

// ── Stub deps: in-memory work-item store, no DB required ──

const stubStore = new Map<string, WorkItemProjection>();
let nextId = 1;

function makeProjection(overrides: Record<string, any> = {}): WorkItemProjection {
  const now = new Date().toISOString();
  return {
    id: `wi-stub-${nextId++}`,
    status: 'backlog',
    goal: '',
    mode: 'execution',
    projectId: '',
    tenantId: '',
    userId: '',
    toolMode: 'project-write',
    priority: 'P1',
    progress: {},
    evidence: {} as any,
    changes: {} as any,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    ...overrides,
  } as unknown as WorkItemProjection;
}

const stubDeps: WorkItemRouteDependencies = {
  createWorkItem: async (input) => {
    const item = makeProjection({
      id: `wi-stub-${nextId++}`,
      goal: (input as any).goal ?? '',
      mode: (input as any).mode ?? 'execution',
      projectId: (input as any).projectId ?? '',
      toolMode: (input as any).toolMode ?? 'project-write',
    });
    (item as any).nextAction = 'start';
    (item as any).availableActions = {
      startWork: {
        label: 'Start in Chat', effect: 'Create a planning attempt for this Work Item.',
        scope: `work_item:${item.id}`, irreversible: false, payload: { workItemId: item.id },
      },
    };
    (item as any).runContractDraft = { phase: 'created' };
    stubStore.set(item.id, item);
    return item;
  },
  createWorkItemRevision: async (_input) =>
    ({ id: `rev-stub-${nextId++}`, status: 'in_progress', exhausted: false } as any),
  getWorkItemVerificationCoverage: async (options) => ({
    mode: options.mode ?? 'execution',
    projectId: options.projectId,
    workItems: stubStore.size,
    required: 0,
    succeeded: 0,
    skipped: 0,
    failed: 0,
    pending: 0,
    missing: 0,
    coverage: 0,
  }),
  isWorkItemReviewError: ((error: unknown): error is Error & { code: string } => {
    const e = error as Record<string, unknown> | undefined;
    return !!(e && typeof e.code === 'string' && ['not_found', 'run_not_succeeded'].includes(e.code as string));
  }) as any,
  listInboxEntries: async () => [],
  listWorkItemProjections: async () => Array.from(stubStore.values()),
  loadWorkItemProjection: async (id) => stubStore.get(id) ?? null,
  reviewWorkItemResult: async (input) => {
    const item = stubStore.get(input.workItemId);
    if (!item) throw Object.assign(new Error('not found'), { code: 'not_found' });
    const decision = (input as any).decision as string;
    if (decision !== 'revision_requested') {
      throw Object.assign(new Error('Work item has not completed a run yet'), { code: 'run_not_succeeded' });
    }
    (item as any).status = 'in_progress';
    (item as any).changes = { ...(item as any).changes, resultReview: { decision, closeoutReport: (input as any).closeoutReport ?? {} } };
    return item;
  },
};

test('work item routes create and read a structured draft without dispatching', async () => {
  const app = Fastify({ logger: false });
  registerRequestContext(app, await loadConfig());
  registerWorkItemRoutes(app, stubDeps);
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
    assert.equal(created.availableActions.startWork.payload.workItemId, workItemId);
    assert.equal(created.runContractDraft.phase, 'created');
    assert.equal(created.evidence.latestRunSpecId, undefined);
    assert.equal(created.evidence.latestTaskRunId, undefined);
    assert.deepEqual(created.verificationRecords, undefined);
    assert.deepEqual(created.changes.workspaces || [], []);

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
    await app.close();
  }
});

test('work item creation rejects missing contract arrays', async () => {
  const app = Fastify({ logger: false });
  registerRequestContext(app, await loadConfig());
  registerWorkItemRoutes(app, stubDeps);
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
