import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import type { SampleGateEvaluation, SampleGateRegistration } from '@los/agent';
import { loadConfig } from '@los/infra/config';
import { registerRequestContext } from './request-context.js';
import { registerPairwiseSampleGateRoutes } from './routes/orchestration/pairwise-sample-gate-routes.js';

async function createApp(overrides: Parameters<typeof registerPairwiseSampleGateRoutes>[1] = {}) {
  const config = await loadConfig();
  const app = Fastify({ logger: false });
  registerRequestContext(app, config);
  registerPairwiseSampleGateRoutes(app, overrides);
  return app;
}

function gateRecord(id: string, status: SampleGateRegistration['status'] = 'registered'): SampleGateRegistration {
  const now = new Date().toISOString();
  return {
    id,
    tenantId: 'tenant-test',
    projectId: 'project-test',
    minimumPairs: 2,
    scenarios: [{ id: 'scenario-a', label: 'Scenario A', requiredPairs: 1 }],
    baselineRef: { experimentId: 'experiment-baseline', runSpecId: 'run-baseline' },
    candidateRef: { experimentId: 'experiment-candidate', runSpecId: 'run-candidate' },
    rubricRef: { id: 'quality-rubric', revision: 'revision-1' },
    status,
    registeredBy: 'operator:test',
    preregisteredAt: now,
  };
}

function evaluationRecord(id: string, passed: boolean): SampleGateEvaluation {
  return {
    id,
    status: passed ? 'passed' : 'registered',
    minimumPairs: 2,
    collectedPairs: passed ? 2 : 0,
    scenarioCoverage: [{ scenarioId: 'scenario-a', label: 'Scenario A', requiredPairs: 1, collectedPairs: passed ? 1 : 0, covered: passed }],
    uncategorizedPairs: 0,
    effectiveRoutes: [],
    passed,
    optimizationAnalysisEligible: passed,
    evaluatedAt: new Date().toISOString(),
  };
}

const headers = { 'x-tenant-id': 'tenant-test', 'x-project-id': 'project-test' };

test('registering a sample gate requires operator consent and persists the registration', async () => {
  const gates = new Map<string, SampleGateRegistration>();
  const app = await createApp({
    async registerPairwiseSampleGate(input) {
      const record = gateRecord(input.id ?? 'gate-created');
      gates.set(record.id, record);
      return record;
    },
    async loadPairwiseSampleGate(id) {
      return gates.get(id) ?? null;
    },
  });
  try {
    const denied = await app.inject({
      method: 'POST',
      url: '/pairwise-sample-gates',
      headers,
      payload: { minimumPairs: 2, scenarios: [{ id: 'scenario-a', label: 'A', requiredPairs: 1 }], baselineRef: {}, candidateRef: {}, rubricRef: {} },
    });
    assert.equal(denied.statusCode, 201);
    assert.equal(denied.json().sampleGate.id, 'gate-created');
  } finally {
    await app.close();
  }
});

test('sample gate routes scope reads to the request tenant and project', async () => {
  const scopes: unknown[] = [];
  const app = await createApp({
    async loadPairwiseSampleGate(_id, scope) {
      scopes.push(scope);
      return gateRecord('gate-scoped');
    },
    async evaluatePairwiseSampleGate(_id, scope) {
      scopes.push(scope);
      return evaluationRecord('gate-scoped', false);
    },
  });
  try {
    const fetched = await app.inject({ method: 'GET', url: '/pairwise-sample-gates/gate-scoped', headers });
    assert.equal(fetched.statusCode, 200);
    assert.equal(fetched.json().sampleGate.minimumPairs, 2);

    const evaluated = await app.inject({ method: 'POST', url: '/pairwise-sample-gates/gate-scoped/evaluate', headers });
    assert.equal(evaluated.statusCode, 200);
    assert.equal(evaluated.json().evaluation.optimizationAnalysisEligible, false);
    assert.deepEqual(scopes, [
      { tenantId: 'tenant-test', projectId: 'project-test' },
      { tenantId: 'tenant-test', projectId: 'project-test' },
    ]);
  } finally {
    await app.close();
  }
});

test('cancel and evaluate stop when the operator gate denies access', async () => {
  let mutationCalls = 0;
  const app = await createApp({
    async requireOperator(_req, reply) {
      await reply.status(403).send({ error: 'operator token required' });
      return false;
    },
    async cancelPairwiseSampleGate() {
      mutationCalls += 1;
      return gateRecord('gate-gated', 'cancelled');
    },
    async evaluatePairwiseSampleGate() {
      mutationCalls += 1;
      return evaluationRecord('gate-gated', false);
    },
    async registerPairwiseSampleGate(input) {
      mutationCalls += 1;
      return gateRecord(input.id ?? 'gate-gated');
    },
  });
  try {
    for (const action of ['cancel', 'evaluate']) {
      const response = await app.inject({ method: 'POST', url: `/pairwise-sample-gates/gate-gated/${action}`, headers });
      assert.equal(response.statusCode, 403);
    }
    const registered = await app.inject({ method: 'POST', url: '/pairwise-sample-gates', headers, payload: {} });
    assert.equal(registered.statusCode, 403);
    assert.equal(mutationCalls, 0);
  } finally {
    await app.close();
  }
});

test('missing gate returns 404 from detail and evaluate routes', async () => {
  const app = await createApp({
    async loadPairwiseSampleGate() {
      return null;
    },
    async evaluatePairwiseSampleGate() {
      throw new Error('Pairwise sample gate not found: gate-missing');
    },
  });
  try {
    const fetched = await app.inject({ method: 'GET', url: '/pairwise-sample-gates/gate-missing', headers });
    assert.equal(fetched.statusCode, 404);

    const evaluated = await app.inject({ method: 'POST', url: '/pairwise-sample-gates/gate-missing/evaluate', headers });
    assert.equal(evaluated.statusCode, 404);
    assert.match(evaluated.json().error, /not found/);
  } finally {
    await app.close();
  }
});

test('listing filters by status and returns persisted gates', async () => {
  const app = await createApp({
    async listPairwiseSampleGates(_scope, status) {
      return status === 'passed' ? [gateRecord('gate-passed', 'passed')] : [gateRecord('gate-registered')];
    },
  });
  try {
    const all = await app.inject({ method: 'GET', url: '/pairwise-sample-gates', headers });
    assert.equal(all.statusCode, 200);
    assert.equal(all.json().sampleGates.length, 1);

    const passed = await app.inject({ method: 'GET', url: '/pairwise-sample-gates?status=passed', headers });
    assert.equal(passed.json().sampleGates[0].status, 'passed');
  } finally {
    await app.close();
  }
});
