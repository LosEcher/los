/**
 * log-detector.test.ts — Tests for log content type detection.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createLogDetector } from './log-detector.js';

const detector = createLogDetector();

describe('createLogDetector', () => {
  it('detects bracketed timestamp format with high confidence', () => {
    const input = [
      '[14:32:01] INFO Starting server on port 3000',
      '[14:32:02] DEBUG Loading configuration',
      '[14:32:03] INFO Server started successfully',
      '[14:32:04] ERROR Failed to connect to database',
      '[14:32:05] WARN Retry attempt 1 of 3',
      '[14:32:06] INFO Connection established',
      '[14:32:07] DEBUG Cache warmed up',
    ].join('\n');

    const result = detector.detect(input);
    assert.ok(result);
    assert.equal(result.type, 'log');
    assert.ok(result.confidence >= 0.9);
  });

  it('detects log level keywords with high confidence', () => {
    const input = [
      '2024-01-15 10:30:45 INFO  [main] Starting application',
      '2024-01-15 10:30:46 DEBUG [main] Loading config from /etc/app.yaml',
      '2024-01-15 10:30:47 WARN  [main] Using default port (no PORT env)',
      '2024-01-15 10:30:48 INFO  [main] Listening on :3000',
      '2024-01-15 10:31:00 ERROR [http] Connection refused: DB at localhost:5432',
      '2024-01-15 10:31:01 FATAL [main] Cannot start without database',
    ].join('\n');

    const result = detector.detect(input);
    assert.ok(result);
    assert.equal(result.type, 'log');
    assert.ok(result.confidence >= 0.85);
  });

  it('detects JSON log format', () => {
    const lines = [];
    for (let i = 0; i < 20; i++) {
      lines.push(JSON.stringify({
        level: i % 5 === 0 ? 'error' : 'info',
        timestamp: new Date().toISOString(),
        message: `log entry ${i}`,
      }));
    }
    const result = detector.detect(lines.join('\n'));
    assert.ok(result);
    assert.equal(result.type, 'log');
    assert.ok(result.confidence >= 0.85);
  });

  it('returns null for plain text', () => {
    const input = 'This is just a plain text message\nwith multiple lines\nbut no log patterns at all.';
    const result = detector.detect(input);
    assert.equal(result, null);
  });

  it('returns null for short input', () => {
    const result = detector.detect('short');
    assert.equal(result, null);
  });

  it('returns low confidence for sparse log patterns', () => {
    const input = Array.from({ length: 30 }, (_, i) =>
      i === 15 ? 'ERROR something broke' : `line ${i} of some output`
    ).join('\n');
    const result = detector.detect(input);
    // Should detect but with low confidence due to sparse keywords
    if (result) {
      assert.ok(result.confidence < 0.7);
    }
  });
});
