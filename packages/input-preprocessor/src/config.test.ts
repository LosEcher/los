/**
 * config.test.ts — Tests for Zod-driven preprocessing configuration.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolveConfig, defaultConfig } from '../src/config.js';

describe('resolveConfig', () => {
  it('returns defaults when no overrides provided', () => {
    const config = resolveConfig();
    assert.equal(config.enabled, true);
    assert.equal(config.tokenBudget, 0);
    assert.equal(config.minRetentionRatio, 0.3);
    assert.equal(config.minConfidence, 0.5);
  });

  it('merges partial overrides', () => {
    const config = resolveConfig({ enabled: false, minConfidence: 0.8 });
    assert.equal(config.enabled, false);
    assert.equal(config.minConfidence, 0.8);
    assert.equal(config.minRetentionRatio, 0.3); // default preserved
  });

  it('rejects negative tokenBudget', () => {
    assert.throws(() => resolveConfig({ tokenBudget: -1 }));
  });

  it('rejects out-of-range minRetentionRatio', () => {
    assert.throws(() => resolveConfig({ minRetentionRatio: 1.5 }));
    assert.throws(() => resolveConfig({ minRetentionRatio: -0.1 }));
  });

  it('provides log config defaults', () => {
    const config = resolveConfig();
    assert.deepEqual(config.log.noiseLevels, ['debug', 'trace']);
    assert.equal(config.log.densityThreshold, 0.6);
    assert.equal(config.log.maxEntryLength, 2000);
    assert.equal(config.log.dedupFingerprint, true);
    assert.equal(config.log.dedupExact, true);
    assert.equal(config.log.contextBeforeError, 5);
    assert.equal(config.log.contextAfterError, 3);
    assert.ok(config.log.elideFields.includes('service_id'));
  });

  it('merges log config overrides', () => {
    const config = resolveConfig({
      log: { noiseLevels: ['debug'], densityThreshold: 0.8 },
    });
    assert.deepEqual(config.log.noiseLevels, ['debug']);
    assert.equal(config.log.densityThreshold, 0.8);
    assert.equal(config.log.maxEntryLength, 2000); // default preserved
  });

  it('provides size guard defaults', () => {
    const config = resolveConfig();
    assert.equal(config.maxInputBytes, 10_485_760); // 10 MB
    assert.equal(config.maxEntries, 100_000);
  });

  it('rejects contextBeforeError over 100', () => {
    assert.throws(() => resolveConfig({
      log: { contextBeforeError: 101 },
    }));
  });
});

describe('defaultConfig', () => {
  it('returns valid default configuration', () => {
    const config = defaultConfig();
    assert.equal(config.enabled, true);
    assert.ok(Array.isArray(config.log.noiseLevels));
  });
});
