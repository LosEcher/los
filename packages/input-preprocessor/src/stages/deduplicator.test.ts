/**
 * deduplicator.test.ts — Tests for exact and fingerprint deduplication.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fingerprint, areStructurallySimilar, createDeduplicator } from './deduplicator.js';
import { createSafetyReport } from '../safety.js';
import { resolveConfig } from '../config.js';
import type { StageInput } from '../types.js';

function makeContext() {
  return {
    contentType: 'log' as const,
    config: resolveConfig(),
    safety: createSafetyReport(),
  };
}

describe('fingerprint', () => {
  it('produces same fingerprint for same structure with different timestamps', () => {
    const a = '[14:32:01] ERROR Connection to 10.0.1.5:5432 failed';
    const b = '[14:32:05] ERROR Connection to 10.0.1.8:5432 failed';
    assert.equal(fingerprint(a), fingerprint(b));
  });

  it('produces same fingerprint for same structure with different UUIDs', () => {
    const a = 'task abc-123 failed: request-id 550e8400-e29b-41d4-a716-446655440000';
    const b = 'task abc-123 failed: request-id 6ba7b810-9dad-11d1-80b4-00c04fd430c8';
    assert.equal(fingerprint(a), fingerprint(b));
  });

  it('produces same fingerprint for same structure with hex addresses', () => {
    const a = 'Segmentation fault at 0x7fff9b3c4d5e';
    const b = 'Segmentation fault at 0x7fff8a2b1c3d';
    assert.equal(fingerprint(a), fingerprint(b));
  });

  it('produces different fingerprints for genuinely different errors', () => {
    const a = 'Connection refused to database';
    const b = 'Null pointer exception in handler';
    assert.notEqual(fingerprint(a), fingerprint(b));
  });
});

describe('areStructurallySimilar', () => {
  it('returns true for structurally identical errors with different values', () => {
    const a = 'ERROR Connection to 10.0.1.5:5432 failed after 30s';
    const b = 'ERROR Connection to 10.0.1.8:5432 failed after 45s';
    assert.ok(areStructurallySimilar(a, b));
  });

  it('returns false for semantically different errors', () => {
    const a = 'ERROR Connection refused to database';
    const b = 'ERROR Permission denied for user';
    assert.ok(!areStructurallySimilar(a, b));
  });

  it('returns false for drastically different lengths', () => {
    const a = 'ERROR short';
    const b = 'ERROR ' + 'x'.repeat(500);
    assert.ok(!areStructurallySimilar(a, b));
  });

  it('handles empty strings safely', () => {
    assert.ok(!areStructurallySimilar('', 'something'));
    assert.ok(!areStructurallySimilar('', ''));
  });
});

describe('createDeduplicator', () => {
  const deduplicator = createDeduplicator();

  it('removes exact duplicates', () => {
    const input: StageInput = {
      entries: [
        { index: 0, text: 'ERROR A' },
        { index: 1, text: 'ERROR B' },
        { index: 2, text: 'ERROR A' },  // duplicate
      ],
      context: makeContext(),
    };
    const result = deduplicator.execute(input);
    assert.equal(result.entries.length, 2);
    assert.equal(result.context.safety.deduplicatedCount, 1);
  });

  it('removes fingerprint duplicates', () => {
    const input: StageInput = {
      entries: [
        { index: 0, text: '[14:32:01] ERROR Connection to 10.0.1.5 failed' },
        { index: 1, text: '[14:35:22] ERROR Connection to 10.0.1.8 failed' },
      ],
      context: makeContext(),
    };
    // Assign fingerprints manually (normally done by deduplicator first)
    input.entries[0]!.fingerprint = fingerprint(input.entries[0]!.text);
    input.entries[1]!.fingerprint = fingerprint(input.entries[1]!.text);

    const result = deduplicator.execute(input);
    assert.equal(result.entries.length, 1);
    assert.equal(result.context.safety.deduplicatedCount, 1);
  });

  it('keeps unique entries', () => {
    const input: StageInput = {
      entries: [
        { index: 0, text: 'ERROR Disk full' },
        { index: 1, text: 'ERROR Permission denied' },
        { index: 2, text: 'ERROR Connection timeout' },
      ],
      context: makeContext(),
    };
    const result = deduplicator.execute(input);
    assert.equal(result.entries.length, 3);
    assert.equal(result.context.safety.deduplicatedCount, 0);
  });

  it('tracks removed entries in backreference map', () => {
    const ctx = makeContext();
    const input: StageInput = {
      entries: [
        { index: 0, text: 'ERROR Unique error' },
        { index: 1, text: 'ERROR Unique error' },
      ],
      context: ctx,
    };
    const result = deduplicator.execute(input);
    const keys = Object.keys(result.context.safety.backreferenceMap);
    assert.ok(keys.length >= 1);
    assert.ok(keys[0]!.startsWith('dedup:'));
  });

  it('handles empty entry list', () => {
    const input: StageInput = {
      entries: [],
      context: makeContext(),
    };
    const result = deduplicator.execute(input);
    assert.equal(result.entries.length, 0);
  });
});
