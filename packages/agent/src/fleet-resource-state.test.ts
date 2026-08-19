import assert from 'node:assert/strict';
import test from 'node:test';

import { loadConfig } from '@los/infra/config';
import { closeDb, initDb } from '@los/infra/db';

import type { FleetResourceFinding } from './fleet-resources.js';
import {
  _resetFleetResourceStateStoreForTests,
  extractSeveritiesFromFindings,
  loadFleetResourceSeveritiesBatch,
  saveFleetResourceSeverities,
} from './fleet-resource-state.js';

test('extractSeveritiesFromFindings: collapses per-signal severity map', () => {
  const findings: FleetResourceFinding[] = [
    {
      nodeId: 'n',
      signal: 'memory_available',
      severity: 'critical',
      code: 'resource:memory_critical:n',
      message: 'x',
      metrics: {},
    },
    {
      nodeId: 'n',
      signal: 'swap_used',
      severity: 'warning',
      code: 'resource:swap_high:n',
      message: 'y',
      metrics: {},
    },
  ];
  assert.deepEqual(extractSeveritiesFromFindings(findings), {
    memory_available: 'critical',
    swap_used: 'warning',
  });
  assert.deepEqual(extractSeveritiesFromFindings([]), {});
});

test('fleet_resource_state store round-trips severities', async () => {
  const config = await loadConfig();
  await initDb(config.databaseUrl);
  _resetFleetResourceStateStoreForTests();
  try {
    const db = (await import('@los/infra/db')).getDb();
    await db.exec('DROP TABLE IF EXISTS fleet_resource_state');
    _resetFleetResourceStateStoreForTests();

    assert.deepEqual((await loadFleetResourceSeveritiesBatch(['mbp'])).mbp, {});

    await saveFleetResourceSeverities('mbp', { memory_available: 'warning' });
    assert.deepEqual((await loadFleetResourceSeveritiesBatch(['mbp'])).mbp, {
      memory_available: 'warning',
    });

    // Upsert replaces the whole map.
    await saveFleetResourceSeverities('mbp', {
      memory_available: 'critical',
      swap_used: 'warning',
    });
    assert.deepEqual((await loadFleetResourceSeveritiesBatch(['mbp'])).mbp, {
      memory_available: 'critical',
      swap_used: 'warning',
    });

    // Batch load covers present and absent nodes.
    const batch = await loadFleetResourceSeveritiesBatch(['mbp', 'other']);
    assert.deepEqual(batch.mbp, { memory_available: 'critical', swap_used: 'warning' });
    assert.deepEqual(batch.other, {});

    // Clearing back to empty map.
    await saveFleetResourceSeverities('mbp', {});
    assert.deepEqual((await loadFleetResourceSeveritiesBatch(['mbp'])).mbp, {});
  } finally {
    await closeDb();
  }
});
