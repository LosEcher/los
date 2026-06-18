/**
 * error-detector.test.ts — Tests for error/stack trace content detection.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createErrorDetector } from './error-detector.js';

describe('createErrorDetector', () => {
  it('detects JS/TS stack traces with high confidence', () => {
    const input = [
      'Error: Something went wrong',
      '    at Module.method (/app/src/foo.ts:42:15)',
      '    at async Handler.execute (/app/src/bar.ts:108:22)',
      '    at processTicksAndRejections (node:internal/process/task_queues:95:5)',
    ].join('\n');
    const result = createErrorDetector().detect(input);
    assert.ok(result);
    assert.equal(result!.type, 'error');
    assert.ok(result!.confidence >= 0.85);
  });

  it('detects Caused by chains', () => {
    const input = [
      'java.lang.RuntimeException: Failed to connect',
      '    at com.example.Service.connect(Service.java:42)',
      'Caused by: java.net.ConnectException: Connection refused',
      '    at java.net.Socket.connect(Socket.java:108)',
    ].join('\n');
    const result = createErrorDetector().detect(input);
    assert.ok(result);
    assert.equal(result!.type, 'error');
  });

  it('detects Python tracebacks', () => {
    const input = [
      'Traceback (most recent call last):',
      '  File "/app/main.py", line 42, in <module>',
      '    result = process()',
      '  File "/app/main.py", line 18, in process',
      '    raise ValueError("Invalid input")',
      'ValueError: Invalid input',
    ].join('\n');
    const result = createErrorDetector().detect(input);
    assert.ok(result);
    assert.equal(result!.type, 'error');
    assert.ok(result!.confidence >= 0.75);
  });

  it('detects Go goroutine dumps', () => {
    const input = [
      'goroutine 1 [running]:',
      'main.main()',
      '    /app/main.go:15 +0x85',
      'goroutine 42 [IO wait]:',
      'net.(*netFD).Read()',
      '    /usr/local/go/src/net/fd_unix.go:173 +0x47',
    ].join('\n');
    const result = createErrorDetector().detect(input);
    assert.ok(result);
    assert.equal(result!.type, 'error');
  });

  it('detects Rust panics', () => {
    const input = [
      "thread 'main' panicked at src/main.rs:42:15:",
      'index out of bounds: the len is 0 but the index is 1',
      'note: run with `RUST_BACKTRACE=1` for a backtrace',
    ].join('\n');
    const result = createErrorDetector().detect(input);
    assert.ok(result);
    assert.equal(result!.type, 'error');
    assert.ok(result!.confidence >= 0.80);
  });

  it('detects exception headers with file locations', () => {
    const input = [
      'UnhandledPromiseRejection: This is an error',
      '    at /app/src/index.ts:1:1',
      '    at Module._compile (node:internal/modules/cjs/loader:1376:14)',
    ].join('\n');
    const result = createErrorDetector().detect(input);
    assert.ok(result);
    assert.equal(result!.type, 'error');
  });

  it('returns low confidence for exception keywords without stack frames', () => {
    const input = [
      'Error: something bad happened but no stack trace available',
      'Additional context: the service was restarting',
      'Please check the logs for more details.',
    ].join('\n');
    const result = createErrorDetector().detect(input);
    assert.ok(result);
    assert.equal(result!.type, 'error');
    // Without stack frames, confidence should be moderate.
    assert.ok(result!.confidence >= 0.45 && result!.confidence <= 0.65);
  });

  it('returns null for plain text', () => {
    const input = 'This is just a regular message with no errors or stack traces';
    const result = createErrorDetector().detect(input);
    assert.equal(result, null);
  });

  it('returns null for short input', () => {
    const input = 'Error';
    const result = createErrorDetector().detect(input);
    assert.equal(result, null);
  });

  it('detects sparse file location references', () => {
    const input = Array.from({ length: 10 }, (_, i) =>
      `log line ${i} — see /app/src/module.ts:${i}:0 for details`,
    ).join('\n');
    const result = createErrorDetector().detect(input);
    assert.ok(result);
    assert.equal(result!.type, 'error');
  });
});
