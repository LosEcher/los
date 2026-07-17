import test from 'node:test';
import assert from 'node:assert/strict';

import { reconcilePlanningTodos } from './governance-reconciliation.js';

test('reconcilePlanningTodos reports seed-only, db-only, status drift, and active counts', () => {
  const report = reconcilePlanningTodos({
    seeds: [
      { id: 'todo-a', title: 'A', status: 'done', priority: 'P0' },
      { id: 'todo-b', title: 'B', status: 'ready', priority: 'P1' },
      { id: 'todo-c', title: 'C', status: 'backlog', priority: 'P2' },
    ],
    dbTodos: [
      { id: 'todo-a', title: 'A', status: 'ready', kind: 'task', priority: 'P0', source: 'manual' },
      { id: 'todo-b', title: 'B', status: 'ready', kind: 'task', priority: 'P1', source: 'manual' },
      { id: 'todo-extra', title: 'Extra', status: 'in_progress', kind: 'task', priority: 'P2', source: 'manual' },
      { id: 'todo-archived', title: 'Archived', status: 'done', kind: 'task', priority: 'P2', source: 'manual', archivedAt: '2026-06-13T00:00:00.000Z' },
    ],
  });

  assert.equal(report.seedCount, 3);
  assert.equal(report.dbCount, 4);
  assert.deepEqual(report.seedOnly.map(item => item.id), ['todo-c']);
  assert.deepEqual(report.dbOnly.map(item => item.id), ['todo-archived', 'todo-extra']);
  assert.deepEqual(report.statusDrift, [
    {
      id: 'todo-a',
      title: 'A',
      expectedStatus: 'done',
      actualStatus: 'ready',
      archivedAt: undefined,
    },
  ]);
  assert.equal(report.activeCounts.ready, 2);
  assert.equal(report.activeCounts.in_progress, 1);
  assert.equal(report.activeCounts.done, 0);
  assert.deepEqual(report.fieldDrift, []);
});

test('reconcilePlanningTodos reports canonical title and priority drift without changing operator-owned fields', () => {
  const report = reconcilePlanningTodos({
    seeds: [{
      id: 'todo-a',
      title: 'Canonical title',
      description: 'Seed description',
      status: 'backlog',
      kind: 'task',
      priority: 'P1',
      source: 'seed',
      metadata: { seed: true },
    }],
    dbTodos: [{
      id: 'todo-a',
      title: 'Operator title',
      status: 'backlog',
      kind: 'plan',
      priority: 'P2',
      source: 'operator',
    }],
  });

  assert.deepEqual(report.fieldDrift, [
    {
      id: 'todo-a',
      title: 'Operator title',
      field: 'priority',
      expectedValue: 'P1',
      actualValue: 'P2',
    },
    {
      id: 'todo-a',
      title: 'Operator title',
      field: 'title',
      expectedValue: 'Canonical title',
      actualValue: 'Operator title',
    },
  ]);
  assert.deepEqual(report.statusDrift, []);
});

test('reconcilePlanningTodos ignores seed items without stable ids', () => {
  const report = reconcilePlanningTodos({
    seeds: [
      { title: 'Generated id at write time', status: 'ready' },
      { id: 'todo-a', title: 'A', status: 'ready' },
    ],
    dbTodos: [
      { id: 'todo-a', title: 'A', status: 'ready', kind: 'task', priority: 'P2', source: 'manual' },
    ],
  });

  assert.equal(report.seedCount, 1);
  assert.deepEqual(report.seedOnly, []);
  assert.deepEqual(report.statusDrift, []);
  assert.deepEqual(report.fieldDrift, []);
});
