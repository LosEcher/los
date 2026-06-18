/**
 * log-denoiser.test.ts — Integration tests for the full log denoising pipeline.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { denoiseLog } from './log-denoiser.js';
import { createSafetyReport } from '../safety.js';
import { resolveConfig } from '../config.js';

function makeSafety() {
  return createSafetyReport();
}

describe('denoiseLog', () => {
  it('preserves all ERROR entries', () => {
    const input = [
      '[14:32:01] INFO Server starting',
      '[14:32:02] ERROR Connection refused to DB',
      '[14:32:03] INFO Retry scheduled',
      '[14:32:04] ERROR Timeout after 30s',
      '[14:32:05] FATAL Cannot recover, shutting down',
    ].join('\n');

    const result = denoiseLog(input, resolveConfig(), makeSafety());
    assert.ok(result.processedText.includes('Connection refused'));
    assert.ok(result.processedText.includes('Timeout'));
    assert.ok(result.processedText.includes('Cannot recover'));
  });

  it('removes low-signal DEBUG and TRACE entries far from errors', () => {
    // 10 DEBUG lines, then 10 TRACE lines, then 5 INFO lines, then 1 ERROR far away.
    const lines: string[] = [];
    for (let i = 0; i < 10; i++) {
      lines.push(`[14:32:${String(i).padStart(2, '0')}] DEBUG Processing item ${i}`);
    }
    for (let i = 0; i < 10; i++) {
      lines.push(`[14:32:${String(i + 10).padStart(2, '0')}] TRACE Tracing step ${i}`);
    }
    for (let i = 0; i < 5; i++) {
      lines.push(`[14:32:${String(i + 20).padStart(2, '0')}] INFO Normal operation ${i}`);
    }
    // Error at the end, 20+ lines away from DEBUG/TRACE.
    lines.push('[14:33:00] ERROR Real error here');

    const input = lines.join('\n');
    const config = resolveConfig({
      log: {
        noiseLevels: ['debug', 'trace'],
        densityThreshold: 0.5,
        contextBeforeError: 3,
        contextAfterError: 1,
      },
    });
    const result = denoiseLog(input, config, makeSafety());

    // Error must survive.
    assert.ok(result.processedText.includes('Real error here'));
    // Most DEBUG/TRACE entries far from error should be removed.
    assert.ok(result.safety.removedByClassifier >= 5);
  });

  it('deduplicates repeated structurally identical errors', () => {
    const lines: string[] = [];
    for (let i = 0; i < 50; i++) {
      lines.push(`[14:${String(i).padStart(2, '0')}:01] ERROR Connection timeout after 30s`);
    }
    const input = lines.join('\n');

    const result = denoiseLog(input, resolveConfig(), makeSafety());
    // Fingerprint dedup should collapse 50 identical errors into 1.
    const occurrences = result.processedText.split('Connection timeout').length - 1;
    assert.equal(occurrences, 1);
    assert.ok(result.safety.deduplicatedCount >= 40);
  });

  it('preserves context around errors (causal chain)', () => {
    const input = [
      '[14:32:01] INFO User login request received',
      '[14:32:02] DEBUG Validating credentials',
      '[14:32:03] INFO Auth service call initiated',
      '[14:32:04] ERROR Auth service returned 500',
      '[14:32:05] INFO Falling back to cache',
      '[14:32:06] WARN Cache miss for user session',
      '[14:32:07] INFO Login failed, returning 401',
    ].join('\n');

    const config = resolveConfig({ log: { contextBeforeError: 2, contextAfterError: 2 } });
    const result = denoiseLog(input, config, makeSafety());

    // Entries within context window should survive.
    assert.ok(result.processedText.includes('Auth service call initiated'));
    assert.ok(result.processedText.includes('Falling back to cache'));
    assert.ok(result.processedText.includes('Cache miss'));
  });

  it('produces measurable token reduction for verbose logs', () => {
    const lines: string[] = [];
    // 100 DEBUG lines (far from errors to avoid causal chain preservation).
    for (let i = 0; i < 100; i++) {
      lines.push(`[14:30:${String(i % 60).padStart(2, '0')}] DEBUG Processing item ${i} of 1000`);
    }
    // 10 INFO lines.
    for (let i = 0; i < 10; i++) {
      lines.push(`[14:31:${String(i % 60).padStart(2, '0')}] INFO Batch ${i} completed successfully`);
    }
    // 2 ERROR lines at the end (far from DEBUGs).
    lines.push('[14:33:01] ERROR Database connection lost');
    lines.push('[14:33:02] ERROR Transaction rolled back');

    const input = lines.join('\n');
    const config = resolveConfig({
      log: {
        noiseLevels: ['debug', 'trace'],
        densityThreshold: 0.5,
        contextBeforeError: 2,
        contextAfterError: 1,
      },
    });
    const result = denoiseLog(input, config, makeSafety());

    // Token reduction should be significant.
    assert.ok(result.safety.originalTokenEstimate > 0);
    assert.ok(result.safety.deduplicatedCount >= 0);
    assert.ok(result.safety.removedByClassifier > 0);
    // At least some DEBUG entries removed.
    assert.ok(result.safety.removedByClassifier >= 50);

    // Both errors survive.
    assert.ok(result.processedText.includes('Database connection lost'));
    assert.ok(result.processedText.includes('Transaction rolled back'));
  });

  it('preserves WARN entries even with aggressive density threshold', () => {
    const input = [
      '[14:32:01] INFO Server starting',
      '[14:32:02] DEBUG Config loaded',
      '[14:32:03] WARN Disk usage at 90%',
      '[14:32:04] ERROR Connection failed',
      '[14:32:05] WARN Memory usage high',
    ].join('\n');

    // densityThreshold=0 means everything above 0 is eligible for removal.
    // WARN entries must survive this aggressive threshold.
    const config = resolveConfig({
      log: { densityThreshold: 0, noiseLevels: ['debug', 'info', 'warn'] },
    });
    const result = denoiseLog(input, config, makeSafety());

    assert.ok(result.processedText.includes('Disk usage at 90%'));
    assert.ok(result.processedText.includes('Memory usage high'));
    assert.ok(result.processedText.includes('Connection failed'));
  });

  it('handles empty input gracefully', () => {
    const result = denoiseLog('', resolveConfig(), makeSafety());
    assert.equal(result.processedText, '');
  });

  it('is idempotent: running twice produces stable output', () => {
    const input = [
      '[14:32:01] INFO Start',
      '[14:32:02] DEBUG Trace data',
      '[14:32:03] ERROR Something broke',
      '[14:32:04] DEBUG More trace',
      '[14:32:05] INFO End',
    ].join('\n');

    const config = resolveConfig();
    const run1 = denoiseLog(input, config, makeSafety());
    const run2 = denoiseLog(run1.processedText, config, makeSafety());

    // Token count should stabilize (no further significant reduction).
    const r2Removed = run2.safety.removedByClassifier;
    const r1Removed = run1.safety.removedByClassifier;
    assert.ok(r2Removed <= r1Removed + 2,
      `Second run removed ${r2Removed} but first removed ${r1Removed}`);
  });
});
