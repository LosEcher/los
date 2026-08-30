import assert from 'node:assert/strict';
import test from 'node:test';

import {
  appendMaintenanceWindow,
  maintenanceWindowId,
  parseDurationMs,
  pruneExpiredMaintenanceWindows,
  removeMaintenanceWindow,
} from './fleet-maintenance-window.mjs';

test('parseDurationMs accepts bounded operator units', () => {
  assert.equal(parseDurationMs('15m'), 900_000);
  assert.equal(parseDurationMs('8h'), 28_800_000);
  assert.equal(parseDurationMs('2d'), 172_800_000);
  assert.throws(() => parseDurationMs('8 hours'), /duration must use/);
  assert.throws(() => parseDurationMs('0h'), /positive/);
});

test('maintenance window id is stable and content-addressed', () => {
  const window = { start: '2026-08-30T00:00:00.000Z', end: '2026-08-30T08:00:00.000Z' };
  assert.equal(maintenanceWindowId(window), maintenanceWindowId({ ...window }));
  assert.notEqual(
    maintenanceWindowId(window),
    maintenanceWindowId({ ...window, end: '2026-08-30T09:00:00.000Z' }),
  );
});

test('append preserves future windows, prunes expired windows, and deduplicates', () => {
  const now = Date.parse('2026-08-30T00:00:00.000Z');
  const expired = { start: '2026-08-28T00:00:00.000Z', end: '2026-08-29T00:00:00.000Z' };
  const future = { start: '2026-08-31T00:00:00.000Z', end: '2026-08-31T02:00:00.000Z' };
  const away = { start: '2026-08-30T00:00:00.000Z', end: '2026-08-30T08:00:00.000Z' };
  assert.deepEqual(appendMaintenanceWindow([expired, future, away], away, now), [away, future]);
});

test('remove and prune affect only the selected or expired window', () => {
  const first = { start: '2026-08-30T00:00:00.000Z', end: '2026-08-30T08:00:00.000Z' };
  const second = { start: '2026-08-31T00:00:00.000Z', end: '2026-08-31T08:00:00.000Z' };
  assert.deepEqual(removeMaintenanceWindow([first, second], maintenanceWindowId(first)), {
    windows: [second],
    removed: true,
  });
  assert.deepEqual(pruneExpiredMaintenanceWindows([first, second], Date.parse(second.start)), [second]);
});
