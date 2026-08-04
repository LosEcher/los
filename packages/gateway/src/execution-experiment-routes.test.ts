import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import type { ExecutionExperimentRecord, RunSpecRecord } from '@los/agent';
import { loadConfig } from '@los/infra/config';
import { getDb } from '@los/infra/db';
import { registerRequestContext } from './request-context.js';
import { registerExecutionExperimentRoutes } from './routes/orchestration/execution-experiment-routes.js';

async function createApp(overrides: Parameters<typeof registerExecutionExperimentRoutes>[1] = {}) {
  const config = await loadConfig();
  const app = Fastify({ logger: false });
  registerRequestContext(app, config);
  registerExecutionExperimentRoutes(app, overrides);
  return app;
}

function experimentRecord(id: string, status: ExecutionExperimentRecord['status']): ExecutionExperimentRecord {
  const now = new Date().toISOString();
  return {
    id,
    tenantId: 'tenant-test',
    projectId: 'project-test',
    source: { sessionId: 'source-session', runSpecId: 'source-run', eventCursor: 4, evidenceHash: 'sha256:route' },
    configDiff: [{ path: 'model', value: 'candidate-model' }],
    status,
    createdBy: 'operator:test',
    createdAt: now,
    updatedAt: now,
  };
}

function sourceRunSpec(scope = { tenantId: 'tenant-test', projectId: 'project-test' }): RunSpecRecord {
  const now = new Date().toISOString();
  return {
    id: 'source-run',
    sessionId: 'source-session',
    ...scope,
    userId: 'operator:test',
    requestId: 'request-source',
    traceId: 'trace-source',
    prompt: 'verify candidate behavior',
    modelSettings: {},
    workspaceRoot: '/workspace',
    toolMode: 'read-only',
    allowedTools: [],
    toolRetry: {},
    maxLoops: 4,
    timeoutMs: 5_000,
    mcpServers: [],
    runContract: {
      editableSurfaces: ['packages/agent/src'],
      requiredChecks: ['pnpm check'],
      allowedSkippedChecks: [],
      stopConditions: ['focused check passes'],
      evidenceRequired: ['focused check output'],
      externalEvidenceAllowed: [],
      rawEvidenceProhibited: [],
      phase: 'plan_approved',
      plan: [{
        id: 'step-1',
        title: 'Run candidate',
        description: 'Execute the candidate configuration.',
        dependsOnIds: [],
        editableSurfaces: ['packages/agent/src'],
        completionCriteria: 'Focused check passes.',
      }],
      verifications: [{ id: 'verify-1', kind: 'command', description: 'Run focused check.', command: 'pnpm check' }],
      planRevision: 1,
    },
    status: 'created',
    createdAt: now,
    updatedAt: now,
  };
}

test('execution experiment routes keep draft creation separate from operator approval', async () => {
  const records = new Map<string, ExecutionExperimentRecord>();
  const scopes: unknown[] = [];
  const app = await createApp({
    async createExecutionExperiment(input) {
      const now = new Date().toISOString();
      const record: ExecutionExperimentRecord = {
        ...input,
        status: 'draft',
        createdAt: now,
        updatedAt: now,
      };
      records.set(record.id, record);
      return record;
    },
    async loadExecutionExperiment(id, scope) {
      scopes.push(scope);
      return records.get(id) ?? null;
    },
    async approveExecutionExperiment(id, actor, scope) {
      scopes.push(scope);
      const current = records.get(id);
      if (!current) throw new Error(`Execution experiment not found: ${id}`);
      const approved = {
        ...current,
        status: 'approved' as const,
        approvedBy: actor,
        updatedAt: new Date().toISOString(),
      };
      records.set(id, approved);
      return approved;
    },
  });
  const id = `route-experiment-${Date.now()}`;
  try {
    const created = await app.inject({
      method: 'POST', url: '/execution-experiments', payload: {
        id,
        source: { sessionId: 'source-session', runSpecId: 'source-run', eventCursor: 4, evidenceHash: 'sha256:route' },
        configDiff: [{ path: 'model', value: 'candidate-model' }],
      }, headers: { 'x-tenant-id': 'tenant-test', 'x-project-id': 'project-test' },
    });
    assert.equal(created.statusCode, 201);
    assert.equal(created.json().experiment.status, 'draft');

    const headers = { 'x-tenant-id': 'tenant-test', 'x-project-id': 'project-test' };
    const fetched = await app.inject({ method: 'GET', url: `/execution-experiments/${id}`, headers });
    assert.equal(fetched.statusCode, 200);
    assert.equal(fetched.json().experiment.source.evidenceHash, 'sha256:route');

    const approved = await app.inject({ method: 'POST', url: `/execution-experiments/${id}/approve`, headers });
    assert.equal(approved.statusCode, 200);
    assert.equal(approved.json().experiment.status, 'approved');
    assert.deepEqual(scopes, [
      { tenantId: 'tenant-test', projectId: 'project-test' },
      { tenantId: 'tenant-test', projectId: 'project-test' },
    ]);
  } finally {
    await app.close();
  }
});

test('create rejects invalid execution budgets before persistence', async () => {
  let createCalls = 0;
  const app = await createApp({
    async createExecutionExperiment(input) {
      createCalls += 1;
      return experimentRecord(input.id, 'draft');
    },
  });
  const source = { sessionId: 'source-session', runSpecId: 'source-run', eventCursor: 1, evidenceHash: 'sha256:budget' };
  try {
    for (const configDiff of [
      [{ path: 'maxLoops', value: 0 }],
      [{ path: 'timeoutMs', value: 1.5 }],
    ]) {
      const response = await app.inject({
        method: 'POST',
        url: '/execution-experiments',
        payload: { source, configDiff },
      });
      assert.equal(response.statusCode, 422);
      assert.match(response.json().error, /must be a positive integer/);
    }
    assert.equal(createCalls, 0);
  } finally {
    await app.close();
  }
});

test('create rejects config overrides that cannot be applied to a run spec', async () => {
  let createCalls = 0;
  const app = await createApp({
    async createExecutionExperiment(input) {
      createCalls += 1;
      return experimentRecord(input.id, 'draft');
    },
  });
  const source = { sessionId: 'source-session', runSpecId: 'source-run', eventCursor: 1, evidenceHash: 'sha256:config' };
  try {
    for (const [configDiff, expectedError] of [
      [[{ path: 'provider', value: '' }], /provider must be a non-empty string/],
      [[{ path: 'model', value: null }], /model must be a non-empty string/],
      [[{ path: 'toolMode', value: 'write-all' }], /toolMode must be all, project-write, or read-only/],
      [[{ path: 'allowedTools', value: 'read_file' }], /allowedTools must be an array/],
      [[{ path: 'allowedTools', value: ['read_file', ''] }], /allowedTools must be an array/],
      [[{ path: 'modelSettings', value: [] }], /modelSettings must be an object/],
    ] as const) {
      const response = await app.inject({
        method: 'POST',
        url: '/execution-experiments',
        payload: { source, configDiff },
      });
      assert.equal(response.statusCode, 422);
      assert.match(response.json().error, expectedError);
    }
    assert.equal(createCalls, 0);
  } finally {
    await app.close();
  }
});

test('approve and execute stop when the operator gate denies access', async () => {
  let mutationCalls = 0;
  const app = await createApp({
    async requireOperator(_req, reply) {
      await reply.status(403).send({ error: 'operator token required' });
      return false;
    },
    async approveExecutionExperiment() {
      mutationCalls += 1;
      return experimentRecord('experiment-gated', 'approved');
    },
    async loadExecutionExperiment() {
      mutationCalls += 1;
      return experimentRecord('experiment-gated', 'approved');
    },
  });
  try {
    for (const action of ['approve', 'execute']) {
      const response = await app.inject({ method: 'POST', url: `/execution-experiments/experiment-gated/${action}` });
      assert.equal(response.statusCode, 403);
    }
    assert.equal(mutationCalls, 0);
  } finally {
    await app.close();
  }
});

test('create replays a persisted idempotent response without duplicating the experiment', async () => {
  const idempotencyKey = `experiment-idempotency-${Date.now()}`;
  let createCalls = 0;
  const app = await createApp({
    async createExecutionExperiment(input) {
      createCalls += 1;
      return experimentRecord(input.id, 'draft');
    },
  });
  const request = {
    method: 'POST' as const,
    url: '/execution-experiments',
    headers: {
      'idempotency-key': idempotencyKey,
      'x-tenant-id': 'tenant-test',
      'x-project-id': 'project-test',
    },
    payload: {
      id: 'experiment-idempotent',
      source: { sessionId: 'source-session', runSpecId: 'source-run', eventCursor: 4, evidenceHash: 'sha256:idempotent' },
      configDiff: [],
    },
  };
  try {
    const created = await app.inject(request);
    const replayed = await app.inject(request);
    assert.equal(created.statusCode, 201);
    assert.equal(replayed.statusCode, 201);
    assert.equal(created.headers['x-idempotency-status'], 'reserved');
    assert.equal(replayed.headers['x-idempotency-status'], 'replayed');
    assert.equal(replayed.json().experiment.id, created.json().experiment.id);
    assert.equal(createCalls, 1);
  } finally {
    await getDb().query(
      'DELETE FROM idempotency_keys WHERE tenant_id = $1 AND project_id = $2 AND route = $3 AND idempotency_key = $4',
      ['tenant-test', 'project-test', '/execution-experiments', idempotencyKey],
    );
    await app.close();
  }
});

test('execute rejects a source run spec outside the experiment scope', async () => {
  const experiment = experimentRecord('experiment-scope', 'approved');
  const transitions: string[] = [];
  const app = await createApp({
    async loadExecutionExperiment() { return experiment; },
    async loadRunSpec() { return sourceRunSpec({ tenantId: 'tenant-other', projectId: 'project-test' }); },
    async transitionExecutionExperiment(_id, status) {
      transitions.push(status);
      return { ...experiment, status };
    },
  });
  try {
    const response = await app.inject({
      method: 'POST',
      url: `/execution-experiments/${experiment.id}/execute`,
      headers: { 'x-tenant-id': 'tenant-test', 'x-project-id': 'project-test' },
    });
    assert.equal(response.statusCode, 422);
    assert.match(response.json().error, /not found in experiment scope/);
    assert.deepEqual(transitions, []);
  } finally {
    await app.close();
  }
});

for (const completionStatus of ['succeeded', 'blocked'] as const) {
  test(`execute persists candidate approval before running and maps ${completionStatus} completion`, async () => {
    const experiment = experimentRecord(`experiment-${completionStatus}`, 'approved');
    const source = sourceRunSpec();
    const candidateId = `run-${experiment.id}-candidate`;
    let candidate: RunSpecRecord | undefined;
    const events: string[] = [];
    const app = await createApp({
      async loadExecutionExperiment() { return experiment; },
      async loadRunSpec(id) {
        if (id === source.id) return source;
        return id === candidateId ? candidate ?? null : null;
      },
      async createRunSpec(input) {
        events.push(`create:${input.runContract?.phase}`);
        candidate = { ...source, ...input, status: 'created', createdAt: source.createdAt, updatedAt: source.updatedAt } as RunSpecRecord;
        return candidate;
      },
      async setExecutionExperimentCandidate(_id, runSpecId, scope) {
        events.push(`candidate:${runSpecId}:${scope?.tenantId}/${scope?.projectId}`);
        return { ...experiment, candidateRunSpecId: runSpecId };
      },
      async approveRunSpecPhase(id) {
        events.push(`approve:${id}`);
        candidate = { ...candidate!, runContract: { ...candidate!.runContract!, phase: 'plan_approved', previousPhase: 'planning' } };
        return candidate;
      },
      async transitionExecutionState(input) {
        events.push(`run:${input.to}`);
        return {} as never;
      },
      async transitionExecutionExperiment(_id, status, _reason, scope) {
        events.push(`experiment:${status}:${scope?.tenantId}/${scope?.projectId}`);
        return { ...experiment, candidateRunSpecId: candidateId, status };
      },
      async runScheduledAgentTask(input) {
        events.push(`schedule:${input.runContract?.phase}`);
        return { taskRun: { id: 'task-candidate' } } as never;
      },
      async applyDirectRunCompletionStatus() {
        events.push(`complete:${completionStatus}`);
        return { status: completionStatus, blockedVerificationRecordIds: completionStatus === 'blocked' ? ['verify-1'] : [] };
      },
    });
    try {
      const response = await app.inject({
        method: 'POST',
        url: `/execution-experiments/${experiment.id}/execute`,
        headers: { 'x-tenant-id': 'tenant-test', 'x-project-id': 'project-test' },
      });
      assert.equal(response.statusCode, 200);
      assert.equal(response.json().experiment.status, completionStatus);
      assert.deepEqual(events, [
        'create:planning',
        `candidate:${candidateId}:tenant-test/project-test`,
        `approve:${candidateId}`,
        'run:running',
        'experiment:running:tenant-test/project-test',
        'schedule:plan_approved',
        `complete:${completionStatus}`,
        `experiment:${completionStatus}:tenant-test/project-test`,
      ]);
    } finally {
      await app.close();
    }
  });
}

test('select-candidate accepts a non-kernel configDiff and persists a plain candidate', async () => {
  const experiment = experimentRecord('experiment-nonkernel', 'draft');
  experiment.configDiff = [{ path: 'model', value: 'candidate-model' }, { path: 'toolMode', value: 'project-write' }];
  const source = sourceRunSpec();
  const candidateId = 'run-experiment-nonkernel-candidate';
  let createdCandidate: RunSpecRecord | undefined;
  const events: string[] = [];
  const app = await createApp({
    async loadExecutionExperiment() { return experiment; },
    async loadRunSpec(id) {
      if (id === source.id) return source;
      return id === candidateId ? createdCandidate ?? null : null;
    },
    async createRunSpec(input) {
      events.push(`create:toolMode=${input.toolMode}`);
      createdCandidate = { ...source, ...input, id: candidateId, status: 'created', createdAt: source.createdAt, updatedAt: source.updatedAt } as RunSpecRecord;
      return createdCandidate;
    },
    async setExecutionExperimentCandidate(_id, runSpecId, scope) {
      events.push(`candidate:${runSpecId}`);
      return { ...experiment, candidateRunSpecId: runSpecId };
    },
  });
  try {
    const response = await app.inject({
      method: 'POST',
      url: `/execution-experiments/${experiment.id}/select-candidate`,
      headers: { 'x-tenant-id': 'tenant-test', 'x-project-id': 'project-test' },
    });
    assert.equal(response.statusCode, 200);
    const body = response.json();
    assert.equal(body.experiment.status, 'draft');
    assert.equal(body.experiment.candidateRunSpecId, candidateId);
    assert.equal(body.candidateRunSpec.runContract?.executionKernel, undefined);
    assert.equal(body.candidateRunSpec.runContract?.planParentRunSpecId, source.id);
    assert.equal(body.candidateRunSpec.toolMode, 'project-write');
    assert.deepEqual(events, ['create:toolMode=project-write', `candidate:${candidateId}`]);
  } finally {
    await app.close();
  }
});

test('select-candidate rejects a persisted candidate with incompatible lineage', async () => {
  const experiment = experimentRecord('experiment-lineage', 'draft');
  experiment.configDiff = [{ path: 'model', value: 'candidate-model' }];
  const source = sourceRunSpec();
  const candidateId = 'run-experiment-lineage-candidate';
  const foreign = { ...sourceRunSpec(), id: candidateId, runContract: { ...sourceRunSpec().runContract!, planParentRunSpecId: 'other-source' } };
  const app = await createApp({
    async loadExecutionExperiment() { return experiment; },
    async loadRunSpec(id) {
      if (id === source.id) return source;
      if (id === candidateId) return foreign;
      return null;
    },
    async setExecutionExperimentCandidate() { throw new Error('must not overwrite incompatible candidate'); },
  });
  try {
    const response = await app.inject({
      method: 'POST',
      url: `/execution-experiments/${experiment.id}/select-candidate`,
      headers: { 'x-tenant-id': 'tenant-test', 'x-project-id': 'project-test' },
    });
    assert.equal(response.statusCode, 422);
    assert.match(response.json().error, /already occupied by an incompatible record/);
  } finally {
    await app.close();
  }
});
