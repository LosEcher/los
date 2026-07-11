import test from 'node:test';
import assert from 'node:assert/strict';

import { _parseDarwinAvailableMemoryBytes } from './resource-metrics.js';

test('parses macOS available memory from memory_pressure output', () => {
  const totalBytes = 32 * 1024 * 1024 * 1024;
  const output = [
    'The system has 34359738368 bytes.',
    'System-wide memory free percentage: 67%',
  ].join('\n');

  assert.equal(
    _parseDarwinAvailableMemoryBytes(output, totalBytes),
    Math.round(totalBytes * 0.67),
  );
});

test('rejects missing or invalid macOS pressure percentages', () => {
  const totalBytes = 32 * 1024 * 1024 * 1024;

  assert.equal(_parseDarwinAvailableMemoryBytes('no percentage', totalBytes), undefined);
  assert.equal(
    _parseDarwinAvailableMemoryBytes('System-wide memory free percentage: 101%', totalBytes),
    undefined,
  );
});
