import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_NODE_REGISTRY_FILTER, countRegistryFilters, filterRegistryNodes } from './nodes-registry-filter.mjs';

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

test('counts match the three registry tabs', () => {
  assert.deepEqual(countRegistryFilters(rows), { executors: 2, ssh: 1, all: 4 });
});

test('nodes page defaults to the executor filter and keeps GET /nodes unfiltered', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(join(here, 'nodes-page.tsx'), 'utf8');
  assert.match(src, /DEFAULT_NODE_REGISTRY_FILTER/);
  assert.match(src, /filterRegistryNodes/);
  assert.match(src, /getJson<[\s\S]*?>\('\/nodes'\)/);
  assert.doesNotMatch(src, /DELETE/);
  const filterTs = readFileSync(join(here, 'nodes-registry-filter.ts'), 'utf8');
  const filterMjs = readFileSync(join(here, 'nodes-registry-filter.mjs'), 'utf8');
  for (const body of [filterTs, filterMjs]) {
    assert.match(body, /DEFAULT_NODE_REGISTRY_FILTER[^=]*= 'executors'/);
    assert.match(body, /nodeKind === 'executor' && node.status === 'online'/);
    assert.match(body, /nodeKind === 'ssh_target'/);
  }
});
