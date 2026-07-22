import test from 'node:test';
import assert from 'node:assert/strict';

import { LOS_PLANNING_TODO_SEED } from './todo-seeds.js';

const RESOLVED_P0_IDS = [
  'todo-los-p0-file-size-gate',
  'todo-los-p0-db-schema-ddl',
  'todo-los-p0-unwired-exports-ci',
  'todo-los-p0-memory-production',
  'todo-los-p0-governance-sweeper',
  'todo-los-p0-eval-probes',
  'todo-los-p0-ap6-child-contract',
  'todo-los-p0-mcp-connection-leak',
  'todo-los-p0-schema-consistency',
  'todo-los-p0-check-secrets',
  'todo-los-transport-sse-ws-recovery',
  'todo-los-daily-agent-web-work-first-intake',
  'todo-los-daily-agent-approval-execution-resume',
  'todo-los-daily-agent-verification-revision-loop',
] as const;

test('resolved P0 seeds do not regress to active states', () => {
  const resolved = new Map(LOS_PLANNING_TODO_SEED.map(todo => [todo.id, todo]));

  for (const id of RESOLVED_P0_IDS) {
    assert.equal(resolved.get(id)?.status, 'done', id);
  }
});

test('resolved P0 seeds retain completion evidence', () => {
  const resolved = new Map(LOS_PLANNING_TODO_SEED.map(todo => [todo.id, todo]));

  for (const id of RESOLVED_P0_IDS) {
    const todo = resolved.get(id);
    assert.ok(todo, `${id} is missing`);
    assert.ok(Array.isArray(todo.metadata?.evidence), `${todo.id} is missing evidence`);
    assert.ok((todo.metadata?.evidence as unknown[]).length > 0, `${todo.id} has empty evidence`);
  }
});

const EXECUTION_LAB_PRIORITIES = new Map([
  ['todo-los-execution-lab', 'P0'],
  ['todo-los-execution-observability-projection', 'P0'],
  ['todo-los-execution-experiment-contract', 'P1'],
  ['todo-los-execution-pairwise-rubric-eval', 'P1'],
  ['todo-los-execution-optimization-analysis', 'P2'],
  ['todo-los-external-trace-adapters', 'P3'],
] as const);

const EXECUTION_LAB_STATES: ReadonlyMap<string, string> = new Map([
  ['todo-los-execution-lab', 'in_progress'],
  ['todo-los-execution-observability-projection', 'done'],
] as const);

const CURRENT_ACTIVE_P0_P1: ReadonlyMap<string, readonly [string, string]> = new Map([
  ['todo-los-execution-lab', ['P0', 'in_progress']],
  ['todo-los-daily-agent-product', ['P0', 'in_progress']],
  ['todo-los-multi-gateway-entry', ['P1', 'backlog']],
  ['todo-los-run-spec-stream-replay', ['P1', 'backlog']],
  ['todo-los-execution-experiment-contract', ['P1', 'backlog']],
  ['todo-los-execution-pairwise-rubric-eval', ['P1', 'backlog']],
  ['todo-los-p1-otel-docs', ['P1', 'ready']],
  ['todo-los-p1-perf-metrics', ['P1', 'backlog']],
  ['todo-los-p1-cbm-ab-inject', ['P1', 'backlog']],
  ['todo-los-p1-context-reconstruction', ['P1', 'backlog']],
  ['todo-los-p1-stale-detection', ['P1', 'backlog']],
  ['todo-los-p1-supply-chain-full', ['P1', 'backlog']],
  ['todo-los-p1-turbo-cache', ['P1', 'ready']],
  ['todo-los-p1-los-ast-rules', ['P1', 'backlog']],
] as const);

test('daily agent product seeds preserve the accepted delivery order', () => {
  const allById = new Map(LOS_PLANNING_TODO_SEED.map(todo => [todo.id, todo]));
  const phase = allById.get('todo-los-daily-agent-product');
  const planning = allById.get('todo-los-daily-agent-planning-disposition');
  const intake = allById.get('todo-los-daily-agent-web-work-first-intake');
  const execution = allById.get('todo-los-daily-agent-approval-execution-resume');
  const revision = allById.get('todo-los-daily-agent-verification-revision-loop');
  const economics = allById.get('todo-los-daily-agent-scenario-economics');
  const graph = allById.get('todo-los-daily-agent-small-governed-graphs');
  const hermes = allById.get('todo-los-hermes-product-breadth');

  assert.equal(phase?.status, 'in_progress');
  assert.equal(planning?.status, 'done');
  assert.ok(Array.isArray(planning?.metadata?.evidence));
  assert.deepEqual(intake?.dependsOnIds, [planning?.id]);
  assert.deepEqual(execution?.dependsOnIds, [planning?.id]);
  assert.deepEqual(revision?.dependsOnIds, [execution?.id]);
  assert.deepEqual(economics?.dependsOnIds, [revision?.id]);
  assert.equal(economics?.status, 'done');
  assert.equal(economics?.metadata?.collectionStatus, 'ready_for_policy_review');
  assert.ok((economics?.metadata?.evidence as string[]).some(item => item.includes('30/30 completed scenario runs')));
  assert.deepEqual(graph?.dependsOnIds, [economics?.id, 'todo-los-p1-test-coverage']);
  assert.equal(graph?.status, 'done');
  assert.ok((graph?.metadata?.validation as string[]).some(item => item.includes('pnpm run gate')));
  assert.deepEqual(graph?.metadata?.graphContract, {
    minWorkers: 2,
    maxWorkers: 4,
    editableSurfaceMode: 'strict',
    verifierRequired: true,
    integrationOwnerRequired: true,
  });
  assert.equal(hermes?.stageId, 'hermes-product-breadth');
  assert.notEqual(hermes?.parentId, phase?.id);
});

test('active P0/P1 seeds match the reconciled current queue', () => {
  const active = LOS_PLANNING_TODO_SEED.filter(
    todo => todo.status !== 'done'
      && todo.status !== 'cancelled'
      && (todo.priority === 'P0' || todo.priority === 'P1'),
  );

  assert.equal(active.length, CURRENT_ACTIVE_P0_P1.size);
  assert.equal(new Set(active.map(todo => todo.id)).size, active.length);

  for (const todo of active) {
    assert.ok(todo.id, 'active P0/P1 seed is missing an id');
    assert.deepEqual(
      [todo.priority, todo.status],
      CURRENT_ACTIVE_P0_P1.get(todo.id),
      `${todo.id} is not in the reconciled current queue`,
    );
  }
});

test('execution lab seeds preserve the staged priority and dependency contract', () => {
  const allById = new Map(LOS_PLANNING_TODO_SEED.map(todo => [todo.id, todo]));
  const executionLabTodos = LOS_PLANNING_TODO_SEED.filter(todo => todo.stageId === 'execution-lab');

  assert.equal(executionLabTodos.length, EXECUTION_LAB_PRIORITIES.size);
  assert.equal(new Set(executionLabTodos.map(todo => todo.id)).size, executionLabTodos.length);
  assert.equal(new Set(executionLabTodos.map(todo => todo.dedupeKey)).size, executionLabTodos.length);

  for (const [id, priority] of EXECUTION_LAB_PRIORITIES) {
    const todo = allById.get(id);
    assert.ok(todo, `${id} is missing`);
    assert.equal(todo.status, EXECUTION_LAB_STATES.get(id) ?? 'backlog', `${id} scheduling state drifted`);
    assert.equal(todo.priority, priority, `${id} priority drifted`);
    assert.ok(todo.metadata?.priorityReason || id === 'todo-los-execution-lab', `${id} is missing a priority reason`);

    for (const dependencyId of todo.dependsOnIds ?? []) {
      assert.ok(allById.has(dependencyId), `${id} depends on missing seed ${dependencyId}`);
    }
  }

  const projection = allById.get('todo-los-execution-observability-projection');
  assert.equal(projection?.parentId, 'todo-los-execution-lab');
  assert.ok(!projection?.dependsOnIds?.includes('todo-los-execution-lab'), 'phase parent must not block its child task');
});
