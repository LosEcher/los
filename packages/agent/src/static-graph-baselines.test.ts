import test from 'node:test';
import assert from 'node:assert/strict';

import { diffBaselines, summarizeBaselineDiff } from './static-graph-baselines.js';

test('static graph baselines: diffBaselines detects new nodes', () => {
  const prev = { nodes: [{ id: 'a', kind: 'cli', label: 'A' }], edges: [], warnings: [] };
  const cur = {
    nodes: [
      { id: 'a', kind: 'cli', label: 'A' },
      { id: 'b', kind: 'route', label: 'B' },
    ],
    edges: [],
    warnings: [],
  };

  const diff = diffBaselines(cur, prev);
  assert.deepEqual(diff.newNodeIds, ['b']);
  assert.deepEqual(diff.removedNodeIds, []);
  assert.equal(diff.newEdges.length, 0);
  assert.equal(diff.removedEdges.length, 0);
  assert.equal(diff.changedNodeKinds.length, 0);
});

test('static graph baselines: diffBaselines detects removed nodes', () => {
  const prev = { nodes: [{ id: 'a', kind: 'cli', label: 'A' }, { id: 'b', kind: 'route', label: 'B' }], edges: [], warnings: [] };
  const cur = { nodes: [{ id: 'a', kind: 'cli', label: 'A' }], edges: [], warnings: [] };

  const diff = diffBaselines(cur, prev);
  assert.deepEqual(diff.removedNodeIds, ['b']);
  assert.deepEqual(diff.newNodeIds, []);
});

test('static graph baselines: diffBaselines detects new and removed edges', () => {
  const prev = {
    nodes: [{ id: 'a', kind: 'cli', label: 'A' }, { id: 'b', kind: 'route', label: 'B' }],
    edges: [{ from: 'a', to: 'b', kind: 'dispatches_to' }],
    warnings: [],
  };
  const cur = {
    nodes: [{ id: 'a', kind: 'cli', label: 'A' }, { id: 'b', kind: 'route', label: 'B' }],
    edges: [
      { from: 'b', to: 'a', kind: 'handled_by' },
      { from: 'a', to: 'b', kind: 'dispatches_to' }, // kept
    ],
    warnings: [],
  };

  const diff = diffBaselines(cur, prev);
  assert.equal(diff.newEdges.length, 1);
  assert.equal(diff.newEdges[0].kind, 'handled_by');
  assert.equal(diff.removedEdges.length, 0); // dispatches_to is in both
});

test('static graph baselines: diffBaselines detects kind changes', () => {
  const prev = { nodes: [{ id: 'a', kind: 'cli', label: 'A' }], edges: [], warnings: [] };
  const cur = { nodes: [{ id: 'a', kind: 'route', label: 'A' }], edges: [], warnings: [] };

  const diff = diffBaselines(cur, prev);
  assert.equal(diff.changedNodeKinds.length, 1);
  assert.deepEqual(diff.changedNodeKinds[0], { id: 'a', oldKind: 'cli', newKind: 'route' });
});

test('static graph baselines: diffBaselines detects warning changes', () => {
  const prev = { nodes: [], edges: [], warnings: ['old warning'] };
  const cur = { nodes: [], edges: [], warnings: ['new warning'] };

  const diff = diffBaselines(cur, prev);
  assert.deepEqual(diff.warningChanges.added, ['new warning']);
  assert.deepEqual(diff.warningChanges.removed, ['old warning']);
});

test('static graph baselines: summarizeBaselineDiff reports no changes for identical graphs', () => {
  const result = summarizeBaselineDiff({
    baselineId: '',
    newNodeIds: [],
    removedNodeIds: [],
    newEdges: [],
    removedEdges: [],
    changedNodeKinds: [],
    warningChanges: { added: [], removed: [] },
  });
  assert.equal(result.hasChanges, false);
  assert.equal(result.summary, 'no structural changes');
});

test('static graph baselines: summarizeBaselineDiff reports all change types', () => {
  const result = summarizeBaselineDiff({
    baselineId: '',
    newNodeIds: ['a', 'b'],
    removedNodeIds: ['c'],
    newEdges: [{ from: 'x', to: 'y', kind: 'calls' }],
    removedEdges: [],
    changedNodeKinds: [{ id: 'd', oldKind: 'cli', newKind: 'route' }],
    warningChanges: { added: [], removed: [] },
  });
  assert.equal(result.hasChanges, true);
  assert.ok(result.summary.includes('2 new nodes'));
  assert.ok(result.summary.includes('1 removed nodes'));
  assert.ok(result.summary.includes('1 new edges'));
  assert.ok(result.summary.includes('1 kind changes'));
});
