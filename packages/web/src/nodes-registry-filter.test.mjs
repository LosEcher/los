import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_NODE_REGISTRY_FILTER,
  countRegistryFilters,
  filterRegistryNodes,
  nodeLiveness,
} from './nodes-registry-filter.mjs';

const rows = [
  { nodeId: 'mbp-executor-1', nodeKind: 'executor', status: 'online' },
  { nodeId: 'test-curl', nodeKind: 'executor', status: 'offline' },
  { nodeId: 'hh-sgp1-r-t', nodeKind: 'ssh_target', status: 'offline' },
  { nodeId: 'vultr-executor', nodeKind: 'executor', status: 'online' },
];

test('default registry filter is live executors', () => {
  assert.equal(DEFAULT_NODE_REGISTRY_FILTER, 'executors');
  assert.deepEqual(
    filterRegistryNodes(rows, DEFAULT_NODE_REGISTRY_FILTER).map(n => n.nodeId),
    ['mbp-executor-1', 'vultr-executor'],
  );
});

test('ssh filter keeps inventory rows without deleting them', () => {
  assert.deepEqual(filterRegistryNodes(rows, 'ssh').map(n => n.nodeId), ['hh-sgp1-r-t']);
  assert.deepEqual(filterRegistryNodes(rows, 'all').map(n => n.nodeId), rows.map(n => n.nodeId));
});

test('counts match the three registry tabs and break down the visible set', () => {
  assert.deepEqual(countRegistryFilters(rows), {
    executors: 2,
    executorsDraining: 0,
    executorsUnknown: 0,
    ssh: 1,
    all: 4,
  });
});

// ── D1: unknown is not offline (ADR 0048 / audit migration item D1) ──────────

test('liveness projects missing and unrecognized statuses to unknown, never offline', () => {
  assert.equal(nodeLiveness('online'), 'online');
  assert.equal(nodeLiveness('draining'), 'draining');
  assert.equal(nodeLiveness('offline'), 'offline');
  assert.equal(nodeLiveness(undefined), 'unknown');
  assert.equal(nodeLiveness(null), 'unknown');
  assert.equal(nodeLiveness(''), 'unknown');
  // A status added by a newer gateway must not be rendered as "down".
  assert.equal(nodeLiveness('quarantined'), 'unknown');
});

test('draining and unknown executors stay visible; only confirmed-offline rows are hidden', () => {
  const mixed = [
    ...rows,
    { nodeId: 'rollout-node', nodeKind: 'executor', status: 'draining' },
    { nodeId: 'silent-node', nodeKind: 'executor', status: '' },
    { nodeId: 'future-node', nodeKind: 'executor', status: 'quarantined' },
  ];
  assert.deepEqual(
    filterRegistryNodes(mixed, 'executors').map(n => n.nodeId),
    ['mbp-executor-1', 'vultr-executor', 'rollout-node', 'silent-node', 'future-node'],
  );
  const counts = countRegistryFilters(mixed);
  assert.equal(counts.executors, 5); // the tab counts exactly what it shows
  assert.equal(counts.executorsDraining, 1);
  assert.equal(counts.executorsUnknown, 2);
  assert.equal(counts.all, 7);
});

test('an empty response is not a liveness claim (no rows ⇒ no offline claim)', () => {
  assert.deepEqual(filterRegistryNodes(undefined, 'executors'), []);
  assert.deepEqual(countRegistryFilters(undefined), {
    executors: 0,
    executorsDraining: 0,
    executorsUnknown: 0,
    ssh: 0,
    all: 0,
  });
});

test('nodes page distinguishes a failed fetch from an empty registry', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(join(here, 'nodes-page.tsx'), 'utf8');
  // A failed query must not be reported as "No executor nodes have heartbeated yet."
  assert.match(src, /error=\{nodes\.isError \? t\('ops\.nodes\.loadFailed'\) : undefined\}/);
  const ui = readFileSync(join(here, 'ui.tsx'), 'utf8');
  assert.match(ui, /if \(error && rows\.length === 0\) return <EmptyText text=\{error\} \/>;/);
});

test('nodes page defaults to the executor filter and keeps GET /nodes unfiltered', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(join(here, 'nodes-page.tsx'), 'utf8');
  assert.match(src, /DEFAULT_NODE_REGISTRY_FILTER/);
  assert.match(src, /filterRegistryNodes/);
  assert.match(src, /getJson<[\s\S]*?>\('\/nodes'\)/);
  assert.doesNotMatch(src, /DELETE/);
  // The .ts (app) and .mjs (test) twins must agree on the rule; the shared marker
  // below is what keeps the duplication from drifting.
  const filterTs = readFileSync(join(here, 'nodes-registry-filter.ts'), 'utf8');
  const filterMjs = readFileSync(join(here, 'nodes-registry-filter.mjs'), 'utf8');
  for (const body of [filterTs, filterMjs]) {
    assert.match(body, /DEFAULT_NODE_REGISTRY_FILTER[^=]*= 'executors'/);
    assert.match(body, /export function nodeLiveness\(/);
    assert.match(body, /nodeLiveness\(node\.status\) !== 'offline'/);
    assert.match(body, /nodeKind === 'ssh_target'/);
  }
});
