/**
 * classifier.test.ts — Tests for density scoring and log level extraction.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { extractLogLevel, createClassifier } from './classifier.js';
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

describe('extractLogLevel', () => {
  it('extracts bracketed log level', () => {
    assert.equal(extractLogLevel('[ERROR] Something failed'), 'error');
    assert.equal(extractLogLevel('[WARN] Caution'), 'warn');
    assert.equal(extractLogLevel('[DEBUG] Tracing'), 'debug');
  });

  it('extracts space-separated log level', () => {
    assert.equal(extractLogLevel('ERROR Something failed'), 'error');
    assert.equal(extractLogLevel('INFO  Server started'), 'info');
  });

  it('extracts from JSON log entry', () => {
    const json = JSON.stringify({ level: 'error', message: 'failed' });
    assert.equal(extractLogLevel(json), 'error');
  });

  it('normalizes WARNING to warn', () => {
    assert.equal(extractLogLevel('WARNING Deprecated API'), 'warn');
  });

  it('returns unknown for plain text', () => {
    assert.equal(extractLogLevel('Just some text'), 'unknown');
  });
});

describe('createClassifier', () => {
  const classifier = createClassifier();

  it('assigns zero density to ERROR entries', () => {
    const input: StageInput = {
      entries: [{ index: 0, text: '[ERROR] Connection failed' }],
      context: makeContext(),
    };
    const result = classifier.execute(input);
    assert.equal(result.entries[0]!.density, 0);
    assert.equal(result.entries[0]!.level, 'error');
  });

  it('assigns zero density to FATAL entries', () => {
    const input: StageInput = {
      entries: [{ index: 0, text: '[FATAL] Out of memory' }],
      context: makeContext(),
    };
    const result = classifier.execute(input);
    assert.equal(result.entries[0]!.density, 0);
  });

  it('assigns higher density to DEBUG entries', () => {
    const input: StageInput = {
      entries: [{ index: 0, text: '[DEBUG] Trace point reached' }],
      context: makeContext(),
    };
    const result = classifier.execute(input);
    assert.ok((result.entries[0]!.density ?? 0) >= 0.4);
  });

  it('caps WARN density at 0.3', () => {
    const input: StageInput = {
      entries: [{ index: 0, text: '[WARN] heartbeat: server alive' }],
      context: makeContext(),
    };
    const result = classifier.execute(input);
    assert.ok((result.entries[0]!.density ?? 0) <= 0.3);
  });

  it('detects heartbeat entries and boosts density', () => {
    const plainWarn: StageInput = {
      entries: [{ index: 0, text: '[WARN] Disk space low' }],
      context: makeContext(),
    };
    const heartbeatWarn: StageInput = {
      entries: [{ index: 0, text: '[WARN] heartbeat check passed' }],
      context: makeContext(),
    };
    const plainResult = classifier.execute(plainWarn);
    const heartbeatResult = classifier.execute(heartbeatWarn);
    assert.ok(
      (heartbeatResult.entries[0]!.density ?? 0) >= (plainResult.entries[0]!.density ?? 0),
    );
  });
});
