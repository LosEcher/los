import test from 'node:test';
import assert from 'node:assert/strict';
import { getDb } from '@los/infra/db';

import { createTodosFromFindings } from './governance-sweep-todos.js';
import { listTodos } from './todos.js';
import type { GovernanceJob } from './governance-jobs-types.js';

test('reflection findings remain idempotent and track resolution', async () => {
  const scope = `reflection-finding-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const makeJob = (id: string): GovernanceJob => ({
    id,
    jobType: 'reflection',
    cadence: 'daily',
    status: 'active',
    config: {},
    tenantId: scope,
    projectId: scope,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    consecutiveNoOps: 0,
    consecutiveFailures: 0,
    circuitState: 'closed',
  });

  try {
    const activeSummary = {
      tasksWithoutReflection: 1,
      tasksWithReflection: 0,
      coverage: '0%',
      recoveryTypes: 'none',
      recoveryTodosCreated: 0,
    };
    assert.equal(await createTodosFromFindings(makeJob('reflection-first'), activeSummary, false), 2);
    assert.equal(await createTodosFromFindings(makeJob('reflection-second'), activeSummary, false), 2);

    let findings = await listTodos({ tenantId: scope, projectId: scope, source: 'governance_sweep', limit: 20 });
    assert.equal(findings.length, 2);
    assert.ok(findings.every(todo => todo.metadata.sweepJobId === 'reflection-second'));

    assert.equal(await createTodosFromFindings(makeJob('reflection-resolved'), {
      ...activeSummary,
      tasksWithoutReflection: 0,
      tasksWithReflection: 1,
      coverage: '100%',
    }, false), 1);
    findings = await listTodos({
      tenantId: scope,
      projectId: scope,
      source: 'governance_sweep',
      includeArchived: true,
      limit: 20,
    });
    const missing = findings.find(todo => todo.metadata.auditType === 'missingReflection');
    const summary = findings.find(todo => todo.metadata.auditType === 'reflectionSummary');
    assert.ok(missing?.archivedAt);
    assert.equal(summary?.archivedAt, undefined);
    assert.match(summary?.title ?? '', /100%/);

    assert.equal(await createTodosFromFindings(makeJob('reflection-regressed'), activeSummary, false), 2);
    findings = await listTodos({ tenantId: scope, projectId: scope, source: 'governance_sweep', limit: 20 });
    assert.equal(findings.length, 2);
    assert.ok(findings.every(todo => todo.archivedAt === undefined));
  } finally {
    await getDb().query('DELETE FROM todos WHERE tenant_id = $1 AND project_id = $2', [scope, scope]);
  }
});

test('hotspot findings remain idempotent and archive after resolution', async () => {
  const scope = `hotspot-finding-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const makeJob = (id: string): GovernanceJob => ({
    id,
    jobType: 'hotspot',
    cadence: 'daily',
    status: 'active',
    config: {},
    tenantId: scope,
    projectId: scope,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    consecutiveNoOps: 0,
    consecutiveFailures: 0,
    circuitState: 'closed',
  });

  try {
    const activeSummary = {
      runtimeCleanup: {
        illegalStatusCount: 0,
        staleFixtureCount: 3,
        staleTaskFixtureCount: 1,
        staleRunSpecFixtureCount: 2,
      },
    };
    assert.equal(await createTodosFromFindings(makeJob('hotspot-first'), activeSummary, false), 1);
    assert.equal(await createTodosFromFindings(makeJob('hotspot-second'), activeSummary, false), 1);

    let findings = await listTodos({ tenantId: scope, projectId: scope, source: 'governance_sweep', limit: 20 });
    assert.equal(findings.length, 1);
    assert.equal(findings[0]?.metadata.auditType, 'staleRuntimeFixtures');
    assert.match(findings[0]?.description ?? '', /1 stale task run fixture/);
    assert.match(findings[0]?.description ?? '', /2 stale run spec fixture/);

    assert.equal(await createTodosFromFindings(makeJob('hotspot-resolved'), {
      runtimeCleanup: {
        illegalStatusCount: 0,
        staleFixtureCount: 0,
        staleTaskFixtureCount: 0,
        staleRunSpecFixtureCount: 0,
      },
    }, false), 0);
    findings = await listTodos({
      tenantId: scope,
      projectId: scope,
      source: 'governance_sweep',
      includeArchived: true,
      limit: 20,
    });
    assert.ok(findings[0]?.archivedAt);
  } finally {
    await getDb().query('DELETE FROM todos WHERE tenant_id = $1 AND project_id = $2', [scope, scope]);
  }
});

test('self_bootstrap and adversarial_review findings create dimension todos and archive on resolution', async () => {
  const scope = `bootstrap-finding-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const makeJob = (jobType: 'self_bootstrap' | 'adversarial_review', id: string): GovernanceJob => ({
    id,
    jobType,
    cadence: 'daily',
    status: 'active',
    config: {},
    tenantId: scope,
    projectId: scope,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    consecutiveNoOps: 0,
    consecutiveFailures: 0,
    circuitState: 'closed',
  });

  const bootstrapActive = {
    findingCount: 2,
    findings: [
      { dimension: 'quality_degradation', severity: 'warn', detail: 'schedule.failureRate up 45%' },
      { dimension: 'todo_lifecycle', severity: 'info', detail: 'todo abc in_progress for 20d' },
    ],
  };
  const adversarialActive = {
    findingCount: 2,
    findings: [
      { dimension: 'metric_semantics', severity: 'warn', detail: '103 rows lack body_duration_ms' },
      { dimension: 'provider_ready_vs_usable', severity: 'warn', detail: 'provider kimi: 0 calls in 7d' },
    ],
  };

  try {
    // First run creates one todo per known dimension.
    assert.equal(await createTodosFromFindings(makeJob('self_bootstrap', 'bs-first'), bootstrapActive, false), 2);
    assert.equal(await createTodosFromFindings(makeJob('adversarial_review', 'adv-first'), adversarialActive, false), 2);
    let findings = await listTodos({ tenantId: scope, projectId: scope, source: 'governance_sweep', limit: 20 });
    assert.equal(findings.length, 4);
    const auditTypes = findings.map(todo => todo.metadata.auditType).sort();
    assert.deepEqual(auditTypes, [
      'metricSemantics', 'providerReadyVsUsable', 'qualityDegradation', 'todoStaleness',
    ]);

    // Idempotent: second run with the same findings does not duplicate.
    assert.equal(await createTodosFromFindings(makeJob('self_bootstrap', 'bs-second'), bootstrapActive, false), 2);
    assert.equal(await createTodosFromFindings(makeJob('adversarial_review', 'adv-second'), adversarialActive, false), 2);
    findings = await listTodos({ tenantId: scope, projectId: scope, source: 'governance_sweep', limit: 20 });
    assert.equal(findings.length, 4);

    // Resolved: dimension missing from findings archives its todo.
    assert.equal(await createTodosFromFindings(makeJob('self_bootstrap', 'bs-resolved'), { findingCount: 0, findings: [] }, false), 0);
    assert.equal(await createTodosFromFindings(makeJob('adversarial_review', 'adv-resolved'), { findingCount: 1, findings: [{ dimension: 'stuck_approval', severity: 'warn', detail: 'x' }] }, false), 1);
    findings = await listTodos({
      tenantId: scope,
      projectId: scope,
      source: 'governance_sweep',
      includeArchived: true,
      limit: 20,
    });
    assert.equal(findings.length, 5);
    const byType = (auditType: string) => findings.find(todo => todo.metadata.auditType === auditType);
    assert.ok(byType('qualityDegradation')?.archivedAt);
    assert.ok(byType('todoStaleness')?.archivedAt);
    assert.ok(byType('metricSemantics')?.archivedAt);
    assert.ok(byType('providerReadyVsUsable')?.archivedAt);
    assert.equal(byType('stuckApproval')?.archivedAt, undefined);
    assert.equal(byType('stuckApproval')?.metadata.dimension, 'stuck_approval');
  } finally {
    await getDb().query('DELETE FROM todos WHERE tenant_id = $1 AND project_id = $2', [scope, scope]);
  }
});
