import assert from 'node:assert/strict';
import test from 'node:test';

import Fastify from 'fastify';
import { loadConfig, setConfig } from '@los/infra/config';

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
    links: [],
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
  createQuickWorkItem: async (input) => {
    return await stubDeps.createWorkItem({
      tenantId: input.tenantId,
      projectId: input.projectId,
      userId: input.userId,
      goal: input.goal,
      mode: input.mode ?? 'execution',
      editableSurfaces: [],
      requiredChecks: input.mode === 'audit' ? [] : ['pnpm check'],
      stopConditions: input.mode === 'audit' ? [] : ['All required checks pass'],
      toolMode: 'project-write',
    });
  },
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
  listWorkItemProjections: async (options = {}) => {
    let items = Array.from(stubStore.values());
    if (options.status) {
      items = items.filter(item => item.status === options.status);
    } else if (options.excludeTerminal) {
      items = items.filter(item => item.status !== 'done' && item.status !== 'cancelled');
    }
    const limit = options.limit ?? items.length;
    return items.slice(0, limit);
  },
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
  ensureRunSpecStore: async () => undefined,
  createRunSpec: async (input) => ({ ...input } as any),
  linkWorkItemRun: async (input) => ({
    workItemId: input.workItemId,
    runSpecId: input.runSpecId,
    sessionId: input.sessionId ?? null,
    relationKind: input.relationKind,
  } as any),
  updateBoundTodoFromRun: async () => undefined,
  dispatchPersistedRunSpec: async (runSpecId) => ({ runSpecId, status: 'succeeded' } as any),
};

test('GET /work-items honors excludeTerminal and concrete status filters', async () => {
  const app = Fastify({ logger: false });
  registerRequestContext(app, await loadConfig());
  registerWorkItemRoutes(app, stubDeps);
  try {
    const open = makeProjection({ id: 'wi-open-1', status: 'in_progress', title: 'Open work' });
    const done = makeProjection({ id: 'wi-done-1', status: 'done', title: 'Done work', priority: 'P0' });
    const cancelled = makeProjection({ id: 'wi-cancel-1', status: 'cancelled', title: 'Cancelled work' });
    stubStore.set(open.id, open);
    stubStore.set(done.id, done);
    stubStore.set(cancelled.id, cancelled);

    const openOnly = await app.inject({ method: 'GET', url: '/work-items?excludeTerminal=true&limit=100' });
    assert.equal(openOnly.statusCode, 200);
    const openIds = openOnly.json().results.map((item: { id: string }) => item.id);
    assert.ok(openIds.includes('wi-open-1'));
    assert.equal(openIds.includes('wi-done-1'), false);
    assert.equal(openIds.includes('wi-cancel-1'), false);

    const doneOnly = await app.inject({ method: 'GET', url: '/work-items?status=done&limit=100' });
    assert.equal(doneOnly.statusCode, 200);
    const doneIds = doneOnly.json().results.map((item: { id: string }) => item.id);
    assert.deepEqual(doneIds, ['wi-done-1']);

    // Concrete status wins over excludeTerminal when both are present.
    const statusWins = await app.inject({
      method: 'GET',
      url: '/work-items?status=done&excludeTerminal=true&limit=100',
    });
    assert.equal(statusWins.statusCode, 200);
    assert.deepEqual(
      statusWins.json().results.map((item: { id: string }) => item.id),
      ['wi-done-1'],
    );
  } finally {
    stubStore.clear();
    nextId = 1;
    await app.close();
  }
});

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

test('POST /work-items/:id/start creates a planning run and dispatches it', async () => {
  const app = Fastify({ logger: false });
  registerRequestContext(app, await loadConfig());
  let dispatched: string | undefined;
  let linked: { workItemId?: string; relationKind: string } | undefined;
  registerWorkItemRoutes(app, {
    ...stubDeps,
    dispatchPersistedRunSpec: async (runSpecId) => {
      dispatched = runSpecId;
      return { runSpecId, status: 'succeeded' } as any;
    },
    linkWorkItemRun: async (input) => {
      linked = { workItemId: input.workItemId ?? '', relationKind: input.relationKind ?? 'planning' };
      return input as any;
    },
  });
  try {
    const created = await app.inject({
      method: 'POST',
      url: '/work-items',
      payload: { projectId: 'los', goal: 'Refactor the auth module', mode: 'execution', editableSurfaces: [], requiredChecks: [], stopConditions: [] },
    });
    assert.equal(created.statusCode, 201);
    const workItemId = created.json().id;

    const started = await app.inject({ method: 'POST', url: `/work-items/${workItemId}/start` });
    assert.equal(started.statusCode, 200);
    const body = started.json();
    assert.ok(body.runSpecId.startsWith(`run-${workItemId}-plan-`), body.runSpecId);
    assert.equal(body.planning.status, 'succeeded');
    assert.equal(dispatched, body.runSpecId);
    assert.deepEqual(linked, { workItemId, relationKind: 'planning' });
  } finally {
    await app.close();
  }
});

test('POST /work-items/:id/start rejects already-running work items', async () => {
  const app = Fastify({ logger: false });
  registerRequestContext(app, await loadConfig());
  registerWorkItemRoutes(app, {
    ...stubDeps,
    linkWorkItemRun: async (input) => {
      const item = stubStore.get(input.workItemId);
      if (item) (item as any).links = [...((item as any).links ?? []), { relationKind: input.relationKind }];
      return input as any;
    },
  });
  try {
    const created = await app.inject({
      method: 'POST',
      url: '/work-items',
      payload: { projectId: 'los', goal: 'Already started', mode: 'execution', editableSurfaces: [], requiredChecks: [], stopConditions: [] },
    });
    const workItemId = created.json().id;
    await app.inject({ method: 'POST', url: `/work-items/${workItemId}/start` });
    const second = await app.inject({ method: 'POST', url: `/work-items/${workItemId}/start` });
    assert.equal(second.statusCode, 409);
    assert.match(second.json().error, /planning run already started/);
  } finally {
    await app.close();
  }
});

test('non-operator work item creation pins projectId to requestContext (P1-08)', async () => {
  const previousConfig = await loadConfig();
  const authConfig = {
    ...previousConfig,
    auth: { enabled: true, token: 'access-token', operatorToken: 'operator-token' },
    defaultProjectId: 'los',
  };
  setConfig(authConfig);
  let capturedProjectId: string | undefined;
  const app = Fastify({ logger: false });
  registerRequestContext(app, authConfig);
  registerWorkItemRoutes(app, {
    ...stubDeps,
    createWorkItem: async (input) => {
      capturedProjectId = input.projectId;
      return await stubDeps.createWorkItem(input);
    },
  });
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/work-items',
      headers: { 'x-los-auth-token': 'access-token' },
      payload: {
        projectId: 'evil-project',
        goal: 'scope isolation test',
        mode: 'execution',
        editableSurfaces: [],
        requiredChecks: [],
        stopConditions: [],
      },
    });
    assert.equal(response.statusCode, 201);
    assert.equal(capturedProjectId, 'los');
  } finally {
    setConfig(previousConfig);
    await app.close();
  }
});
