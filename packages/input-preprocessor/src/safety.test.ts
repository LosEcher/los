/**
 * safety.test.ts — Tests for safety guards and invariants.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  createSafetyReport,
  isProtectedEntry,
  validateProtectedEntries,
  maxRemovableEntries,
  buildSafetyHeader,
  shouldSkipProcessing,
  buildPassthroughOutput,
  resetBackrefCounter,
  nextBackrefKey,
  stripAnsi,
} from '../src/safety.js';
import { resolveConfig } from '../src/config.js';
import type { PreprocessEntry } from '../src/types.js';

describe('createSafetyReport', () => {
  it('returns zeroed report', () => {
    const report = createSafetyReport();
    assert.equal(report.totalEntries, 0);
    assert.equal(report.removedByClassifier, 0);
    assert.equal(report.deduplicatedCount, 0);
    assert.equal(report.compressedCount, 0);
    assert.equal(report.compressionRatio, 1);
  });
});

describe('isProtectedEntry', () => {
  it('identifies error entries as protected', () => {
    assert.ok(isProtectedEntry({ index: 0, text: 'error', level: 'error' }));
  });

  it('identifies fatal entries as protected', () => {
    assert.ok(isProtectedEntry({ index: 0, text: 'fatal', level: 'fatal' }));
  });

  it('does not protect warn entries', () => {
    assert.equal(isProtectedEntry({ index: 0, text: 'warn', level: 'warn' }), false);
  });

  it('does not protect entries without a level', () => {
    assert.equal(isProtectedEntry({ index: 0, text: 'no level' }), false);
  });
});

describe('validateProtectedEntries', () => {
  it('returns empty for no violations', () => {
    const before: PreprocessEntry[] = [
      { index: 0, text: 'error', level: 'error' },
      { index: 1, text: 'info', level: 'info' },
    ];
    const after: PreprocessEntry[] = [
      { index: 0, text: 'error', level: 'error' },
    ];
    const violations = validateProtectedEntries(before, after);
    assert.deepEqual(violations, []);
  });

  it('detects removed error entries', () => {
    const before: PreprocessEntry[] = [
      { index: 0, text: 'error', level: 'error' },
    ];
    const after: PreprocessEntry[] = [];
    const violations = validateProtectedEntries(before, after);
    assert.equal(violations.length, 1);
    assert.ok(violations[0]!.includes('SAFETY VIOLATION'));
  });
});

describe('maxRemovableEntries', () => {
  it('calculates remaining removal budget', () => {
    const config = resolveConfig({ minRetentionRatio: 0.3 });
    // 100 total, 0 removed → can remove up to 70
    assert.equal(maxRemovableEntries(100, 0, config), 70);
    // 100 total, 60 removed → can remove up to 10 more
    assert.equal(maxRemovableEntries(100, 60, config), 10);
  });

  it('returns 0 when retention ratio would be violated', () => {
    const config = resolveConfig({ minRetentionRatio: 0.5 });
    assert.equal(maxRemovableEntries(100, 51, config), 0);
  });
});

describe('backreference keys', () => {
  it('generates sequential unique keys', () => {
    resetBackrefCounter();
    const a = nextBackrefKey('test');
    const b = nextBackrefKey('test');
    assert.notEqual(a, b);
    assert.ok(a.startsWith('test:'));
  });
});

describe('buildSafetyHeader', () => {
  it('includes removal counts', () => {
    const report = createSafetyReport();
    report.removedByClassifier = 42;
    report.compressionRatio = 0.5;
    const header = buildSafetyHeader(report, 'log');
    assert.ok(header.includes('42'));
    assert.ok(header.includes('log'));
  });

  it('handles empty report', () => {
    const header = buildSafetyHeader(createSafetyReport(), 'log');
    assert.ok(header.length > 0);
    assert.ok(!header.includes('filtered'));
  });

  it('includes compressed count when present', () => {
    const report = createSafetyReport();
    report.compressedCount = 15;
    const header = buildSafetyHeader(report, 'code');
    assert.ok(header.includes('15'));
    assert.ok(header.includes('compressed'));
  });

  it('includes warning count when present', () => {
    const report = createSafetyReport();
    report.warnings = ['Warning A', 'Warning B'];
    report.compressionRatio = 0.8;
    const header = buildSafetyHeader(report, 'config');
    assert.ok(header.includes('2 warnings'));
  });

  it('includes dedup count when present', () => {
    const report = createSafetyReport();
    report.deduplicatedCount = 7;
    const header = buildSafetyHeader(report, 'mixed');
    assert.ok(header.includes('7'));
    assert.ok(header.includes('duplicates'));
  });
});

describe('shouldSkipProcessing', () => {
  it('skips when disabled', () => {
    const config = resolveConfig({ enabled: false });
    assert.ok(shouldSkipProcessing('text', config));
  });

  it('skips empty input', () => {
    const config = resolveConfig();
    assert.ok(shouldSkipProcessing('', config));
    assert.ok(shouldSkipProcessing('   ', config));
  });

  it('skips mini-input (conversational short text)', () => {
    const config = resolveConfig();
    assert.ok(shouldSkipProcessing('ok', config));
    assert.ok(shouldSkipProcessing('继续', config));
    assert.ok(shouldSkipProcessing('?', config));
  });

  it('does not skip multi-line short text (could be mini-log)', () => {
    const config = resolveConfig();
    const input = 'ERROR\nWARN';
    // Has newlines, so should not be caught by mini-input guard.
    const reason = shouldSkipProcessing(input, config);
    // Should not be "mini-input" — either null (proceed) or another reason.
    assert.ok(!reason || !reason.includes('mini-input'));
  });

  it('skips binary content with null bytes', () => {
    const config = resolveConfig();
    const binaryInput = 'text\0binary';
    const reason = shouldSkipProcessing(binaryInput, config);
    assert.ok(reason);
    assert.ok(reason.includes('binary'));
  });

  it('skips high non-printable ratio input', () => {
    const config = resolveConfig();
    // Construct a long string with >30% non-printable characters.
    const nonPrintable = '\x01\x02\x03\x04\x05\x06\x07\x08';
    const padding = 'A'.repeat(5);
    const input = nonPrintable + padding;
    const reason = shouldSkipProcessing(input, config);
    assert.ok(reason);
    assert.ok(reason.includes('non-printable'));
  });

  it('does not skip low non-printable ratio', () => {
    const config = resolveConfig();
    // Single null byte is caught, but a few non-printables in mostly-printable shouldn't trigger.
    // Our input has \x01 but mostly printable, ratio below 30%.
    const input = '\x01' + 'A'.repeat(100) + '\nline2';
    const reason = shouldSkipProcessing(input, config);
    // Should not be "non-printable ratio" — either null (proceed), or empty/mini/token-budget.
    assert.ok(!reason || !reason.includes('non-printable'));
  });

  it('skips oversized input', () => {
    const config = resolveConfig({ maxInputBytes: 100 });
    const bigInput = 'x'.repeat(200);
    const reason = shouldSkipProcessing(bigInput, config);
    assert.ok(reason);
    assert.ok(reason.includes('too large'));
  });

  it('skips when within token budget', () => {
    const config = resolveConfig({ tokenBudget: 200 });
    const text = 'x'.repeat(100); // ~25 tokens
    assert.ok(shouldSkipProcessing(text, config));
  });

  it('proceeds for normal input', () => {
    const config = resolveConfig();
    const text = 'x'.repeat(10000); // ~2500 tokens, multi-line
    assert.equal(shouldSkipProcessing(text, config), null);
  });
});

describe('buildPassthroughOutput', () => {
  it('preserves original text', () => {
    const text = 'original content';
    const result = buildPassthroughOutput(text, 'test reason', 'unknown');
    assert.equal(result.processedText, text);
    assert.equal(result.metadata.contentType, 'unknown');
    assert.equal(result.metadata.evidence[0], 'test reason');
  });
});

describe('stripAnsi', () => {
  it('returns text unchanged when no ANSI codes present', () => {
    const plain = 'plain text without any escape codes';
    assert.equal(stripAnsi(plain), plain);
  });

  it('strips SGR color codes', () => {
    const input = '\x1b[31mERROR\x1b[0m: something failed';
    const result = stripAnsi(input);
    assert.equal(result, 'ERROR: something failed');
  });

  it('strips CSI cursor and clear sequences', () => {
    const input = '\x1b[2J\x1b[H\x1b[1;32mREADY\x1b[0m';
    const result = stripAnsi(input);
    assert.equal(result, 'READY');
  });

  it('strips OSC (Operating System Command) sequences', () => {
    // OSC: ESC ] 0 ; title BEL
    const input = '\x1b]0;Terminal Title\x07actual output';
    const result = stripAnsi(input);
    assert.equal(result, 'actual output');
  });

  it('handles text with mixed ANSI and content', () => {
    const input = '\x1b[34m[INFO]\x1b[0m \x1b[1mStarting\x1b[0m server on :8080';
    const result = stripAnsi(input);
    assert.equal(result, '[INFO] Starting server on :8080');
  });

  it('handles multi-line ANSI text (typical CI output)', () => {
    const input = [
      '\x1b[2J\x1b[H',
      '\x1b[1;32m✓\x1b[0m Test 1 passed',
      '\x1b[1;31m✗\x1b[0m Test 2 failed: \x1b[31mExpected 5, got 3\x1b[0m',
    ].join('\n');
    const result = stripAnsi(input);
    assert.ok(result.includes('✓ Test 1 passed'));
    assert.ok(result.includes('✗ Test 2 failed: Expected 5, got 3'));
    assert.ok(!result.includes('\x1b'));
  });

  it('handles empty string', () => {
    assert.equal(stripAnsi(''), '');
  });
});
