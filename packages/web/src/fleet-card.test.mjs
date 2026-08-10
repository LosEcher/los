import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, 'fleet-card.tsx'), 'utf8');

test('fleet card loads runtime-health board', () => {
  assert.match(src, /\/ops\/runtime-health/);
  assert.match(src, /fleetResources/);
  assert.match(src, /export function FleetCard/);
});

test('fleet card surfaces status candidate mem and heartbeat', () => {
  assert.match(src, /ops\.fleet\.colStatus/);
  assert.match(src, /ops\.fleet\.colCandidate/);
  assert.match(src, /ops\.fleet\.colMem/);
  assert.match(src, /ops\.fleet\.colHeartbeat/);
  assert.match(src, /memoryAvailableRatio/);
});
