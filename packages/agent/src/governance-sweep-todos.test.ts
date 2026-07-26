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
