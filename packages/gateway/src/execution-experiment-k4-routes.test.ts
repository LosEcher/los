import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import {
  createK4ExecutionKernelSelection,
  getLosKernelSelectionIdentity,
  type ExecutionExperimentRecord,
  type RunSpecRecord,
} from '@los/agent';
import { loadConfig } from '@los/infra/config';
import { registerRequestContext } from './request-context.js';
import { registerExecutionExperimentRoutes } from './routes/orchestration/execution-experiment-routes.js';

async function createApp(overrides: Parameters<typeof registerExecutionExperimentRoutes>[1] = {}) {
  const app = Fastify({ logger: false });
  registerRequestContext(app, await loadConfig());
  registerExecutionExperimentRoutes(app, overrides);
  return app;
}

function experiment(status: ExecutionExperimentRecord['status'], candidateRunSpecId?: string): ExecutionExperimentRecord {
  const now = new Date().toISOString();
  return {
    id: 'experiment-k4',
    tenantId: 'tenant-test',
    projectId: 'project-test',
    source: { sessionId: 'source-session', runSpecId: 'source-run', eventCursor: 4, evidenceHash: 'sha256:k4' },
    configDiff: [
      { path: 'executionKernel', value: { kind: 'pi', version: '0.81.1+los.3', protocolVersion: '0.1.0', disposition: 'inspection' } },
      { path: 'toolMode', value: 'read-only' },
    ],
    candidateRunSpecId,
    status,
    createdBy: 'operator:create',
    createdAt: now,
    updatedAt: now,
  };
}

function runSpec(id = 'source-run'): RunSpecRecord {
  const now = new Date().toISOString();
  return {
    id,
    sessionId: id === 'source-run' ? 'source-session' : 'source-session:experiment:experiment-k4',
    tenantId: 'tenant-test',
    projectId: 'project-test',
    prompt: 'inspect candidate behavior',
    modelSettings: {},
    workspaceRoot: '/workspace',
    toolMode: 'read-only',
    allowedTools: ['read_file'],
    toolRetry: {},
    maxLoops: 4,
    timeoutMs: 5_000,
    mcpServers: [],
    runContract: {
      mode: 'audit',
      executionMode: 'standard',
      editableSurfaces: [],
      requiredChecks: ['verify-k4'],
      allowedSkippedChecks: [],
      stopConditions: ['stop on transcript drift'],
      evidenceRequired: ['canonical events'],
      externalEvidenceAllowed: [],
      rawEvidenceProhibited: [],
      phase: id === 'source-run' ? 'plan_approved' : 'planning',
      plan: [{
        id: 'inspect',
        title: 'Inspect candidate',
        description: 'Inspect without writes.',
        dependsOnIds: [],
        editableSurfaces: [],
        completionCriteria: 'Canonical evidence is persisted.',
      }],
      planRevision: 1,
    },
    status: 'created',
    createdAt: now,
    updatedAt: now,
  };
}

test('K4 candidate selection persists a read-only run spec before approval without scheduling', async () => {
  const record = experiment('draft');
  const source = runSpec();
  let candidate: RunSpecRecord | undefined;
  let scheduled = 0;
  const app = await createApp({
    async loadExecutionExperiment() { return record; },
    async loadRunSpec(id) { return id === source.id ? source : candidate ?? null; },
    async createRunSpec(input) {
      candidate = { ...source, ...input, status: 'created', createdAt: source.createdAt, updatedAt: source.updatedAt } as RunSpecRecord;
      return candidate;
    },
    async setExecutionExperimentCandidate(_id, candidateRunSpecId) { return { ...record, candidateRunSpecId }; },
    async runScheduledAgentTask() { scheduled += 1; throw new Error('must not schedule'); },
  });
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/execution-experiments/experiment-k4/select-candidate',
      headers: { 'x-tenant-id': 'tenant-test', 'x-project-id': 'project-test', 'x-user-id': 'operator:select' },
    });
    assert.equal(response.statusCode, 200);
    assert.equal(candidate?.toolMode, 'read-only');
    assert.equal(candidate?.runContract?.mode, 'audit');
    assert.equal(candidate?.runContract?.phase, 'planning');
    assert.equal(candidate?.runContract?.planParentRunSpecId, 'source-run');
    assert.equal(candidate?.runContract?.executionKernel?.selected.kind, 'pi');
    assert.equal(candidate?.runContract?.executionKernel?.canaryAuthorization.status, 'not_granted');
    assert.equal(scheduled, 0);
  } finally {
    await app.close();
  }
});

test('K4 candidate selection recovers an already persisted compatible candidate', async () => {
  const record = experiment('draft');
  const source = runSpec();
  const candidateId = 'run-experiment-k4-candidate';
  const recovered = {
    ...runSpec(candidateId),
    runContract: {
      ...source.runContract!,
      mode: 'audit' as const,
      phase: 'planning' as const,
      planParentRunSpecId: source.id,
      executionKernel: createK4ExecutionKernelSelection({
        experimentId: record.id,
        disposition: 'inspection',
        actor: 'operator:select',
      }),
    },
  };
  let creates = 0;
  let links = 0;
  const app = await createApp({
    async loadExecutionExperiment() { return record; },
    async loadRunSpec(id) {
      if (id === source.id) return source;
      if (id === candidateId) return recovered;
      return null;
    },
    async createRunSpec() { creates += 1; throw new Error('must not recreate candidate'); },
    async setExecutionExperimentCandidate(_id, linkedId) {
      links += 1;
      return { ...record, candidateRunSpecId: linkedId };
    },
  });
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/execution-experiments/experiment-k4/select-candidate',
      headers: { 'x-tenant-id': 'tenant-test', 'x-project-id': 'project-test', 'x-user-id': 'operator:select' },
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().candidateRunSpec.id, candidateId);
    assert.equal(creates, 0);
    assert.equal(links, 1);
  } finally {
    await app.close();
  }
});

test('K4 canary authorization requires approved experiment, approved plan, and exact confirmation', async () => {
  const record = experiment('approved', 'run-experiment-k4-candidate');
  const candidate = runSpec(record.candidateRunSpecId);
  candidate.runContract = {
    ...candidate.runContract!,
    phase: 'plan_approved',
    executionKernel: createK4ExecutionKernelSelection({ experimentId: record.id, disposition: 'inspection', actor: 'operator:select' }),
  };
  let authorizations = 0;
  const app = await createApp({
    async loadExecutionExperiment() { return record; },
    async loadRunSpec() { return candidate; },
    async authorizeRunSpecKernelCanary() {
      authorizations += 1;
      return {
        ...candidate.runContract!.executionKernel!,
        canaryAuthorization: { status: 'granted' as const, grantedBy: 'operator:authorize', grantedAt: new Date().toISOString() },
      };
    },
  });
  try {
    const rejected = await app.inject({
      method: 'POST',
      url: '/execution-experiments/experiment-k4/authorize-canary',
      payload: { confirmCandidateRunSpecId: 'wrong-run' },
      headers: { 'x-tenant-id': 'tenant-test', 'x-project-id': 'project-test' },
    });
    assert.equal(rejected.statusCode, 422);
    assert.equal(authorizations, 0);

    const authorized = await app.inject({
      method: 'POST',
      url: '/execution-experiments/experiment-k4/authorize-canary',
      payload: { confirmCandidateRunSpecId: candidate.id },
      headers: { 'x-tenant-id': 'tenant-test', 'x-project-id': 'project-test' },
    });
    assert.equal(authorized.statusCode, 200);
    assert.equal(authorized.json().executionKernel.canaryAuthorization.status, 'granted');
    assert.equal(authorizations, 1);
  } finally {
    await app.close();
  }
});

test('K4 rollback selects LOS and execute cannot implicitly create the Pi candidate', async () => {
  const selected = createK4ExecutionKernelSelection({ experimentId: 'experiment-k4', disposition: 'inspection', actor: 'operator:select' });
  const approvedWithoutCandidate = experiment('approved');
  let scheduled = 0;
  let rollbackCalls = 0;
  const app = await createApp({
    async loadExecutionExperiment() { return approvedWithoutCandidate; },
    async loadRunSpec() { return runSpec(); },
    async rollbackRunSpecExecutionKernel() {
      rollbackCalls += 1;
      return rolledBackSelection(selected);
    },
    async runScheduledAgentTask() { scheduled += 1; throw new Error('must not schedule'); },
    async transitionExecutionExperiment(_id, status) { return { ...approvedWithoutCandidate, status }; },
  });
  try {
    const execute = await app.inject({
      method: 'POST',
      url: '/execution-experiments/experiment-k4/execute',
      headers: { 'x-tenant-id': 'tenant-test', 'x-project-id': 'project-test' },
    });
    assert.equal(execute.statusCode, 422);
    assert.match(execute.json().error, /must be selected before execution/);
    assert.equal(scheduled, 0);

    const withCandidate = { ...approvedWithoutCandidate, candidateRunSpecId: 'run-experiment-k4-candidate' };
    const rollbackApp = await createApp({
      async loadExecutionExperiment() { return withCandidate; },
      async rollbackRunSpecExecutionKernel() {
        rollbackCalls += 1;
        return rolledBackSelection(selected);
      },
    });
    try {
      const rollback = await rollbackApp.inject({
        method: 'POST',
        url: '/execution-experiments/experiment-k4/rollback',
        payload: { reason: 'use baseline' },
        headers: { 'x-tenant-id': 'tenant-test', 'x-project-id': 'project-test' },
      });
      assert.equal(rollback.statusCode, 200);
      assert.equal(rollback.json().executionKernel.selected.kind, 'los');
    } finally {
      await rollbackApp.close();
    }
    assert.equal(rollbackCalls, 1);
  } finally {
    await app.close();
  }
});

function rolledBackSelection(selection: ReturnType<typeof createK4ExecutionKernelSelection>) {
  const at = new Date().toISOString();
  const losIdentity = getLosKernelSelectionIdentity();
  return {
    ...selection,
    selected: { ...losIdentity },
    rollback: {
      target: { ...losIdentity },
      status: 'applied' as const,
      appliedAt: at,
      appliedBy: 'operator:rollback',
      reason: 'use baseline',
    },
    canaryAuthorization: { status: 'not_granted' as const },
    history: [...selection.history, {
      action: 'rollback' as const,
      from: selection.selected,
      to: { ...losIdentity },
      actor: 'operator:rollback',
      at,
      reason: 'use baseline',
    }],
  };
}

test('K4 draft creation rejects an inexact kernel identity before persistence', async () => {
  let creates = 0;
  const app = await createApp({
    async createExecutionExperiment(input) { creates += 1; return { ...experiment('draft'), ...input }; },
  });
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/execution-experiments',
      payload: {
        source: { sessionId: 'source-session', runSpecId: 'source-run', eventCursor: 1, evidenceHash: 'sha256:wrong' },
        configDiff: [{ path: 'executionKernel', value: { kind: 'pi', version: '0.81.1', protocolVersion: '0.1.0', disposition: 'inspection' } }],
      },
    });
    assert.equal(response.statusCode, 422);
    assert.match(response.json().error, /exact pi@0.81.1\+los.3/);
    assert.equal(creates, 0);
  } finally {
    await app.close();
  }
});
