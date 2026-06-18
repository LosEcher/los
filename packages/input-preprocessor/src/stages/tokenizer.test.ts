/**
 * tokenizer.test.ts — Tests for logical entry tokenization.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { tokenizeLog, tokenizeGeneric } from './tokenizer.js';

describe('tokenizeLog', () => {
  it('splits simple log lines into entries', () => {
    const input = [
      '[14:32:01] INFO Server started',
      '[14:32:02] ERROR Connection failed',
      '[14:32:03] WARN Retrying',
    ].join('\n');

    const entries = tokenizeLog(input);
    assert.equal(entries.length, 3);
    assert.equal(entries[0]!.text, '[14:32:01] INFO Server started');
    assert.equal(entries[0]!.index, 0);
    assert.equal(entries[1]!.index, 1);
  });

  it('groups stack trace continuation lines', () => {
    const input = [
      '[14:32:01] ERROR Unexpected error',
      '    at com.example.Service.handle(Service.java:42)',
      '    at com.example.Controller.show(Controller.java:18)',
      '    at sun.reflect.Method.invoke(Method.java:100)',
      '[14:32:02] INFO Recovery started',
    ].join('\n');

    const entries = tokenizeLog(input);
    assert.equal(entries.length, 2);
    // First entry should include the error + all stack frames
    assert.ok(entries[0]!.text.includes('Service.java:42'));
    assert.ok(entries[0]!.text.includes('Controller.java:18'));
    assert.ok(entries[0]!.text.includes('Method.java:100'));
    assert.equal(entries[1]!.text, '[14:32:02] INFO Recovery started');
  });

  it('groups Caused by continuation lines', () => {
    const input = [
      'ERROR Database error: connection refused',
      'Caused by: java.net.ConnectException: Connection refused',
      '    at java.net.Socket.connect(Socket.java:200)',
      'INFO Shutting down gracefully',
    ].join('\n');

    const entries = tokenizeLog(input);
    // "Caused by" is a continuation of the error entry
    assert.ok(entries.length <= 3);
    const errorEntry = entries.find(e => e.text.includes('Database error'));
    assert.ok(errorEntry);
    assert.ok(errorEntry.text.includes('Caused by'));
  });

  it('handles empty input', () => {
    const entries = tokenizeLog('');
    assert.equal(entries.length, 0);
  });

  it('handles single line input', () => {
    const entries = tokenizeLog('[14:32:01] INFO Single line');
    assert.equal(entries.length, 1);
    assert.equal(entries[0]!.text, '[14:32:01] INFO Single line');
  });

  it('skips blank lines between entries', () => {
    const input = [
      '[14:32:01] INFO First',
      '',
      '[14:32:02] ERROR Second',
    ].join('\n');

    const entries = tokenizeLog(input);
    assert.equal(entries.length, 2);
  });

  it('assigns sequential indices', () => {
    const input = 'line1\nline2\nline3';
    const entries = tokenizeLog(input);
    assert.equal(entries.length, 3);
    assert.equal(entries[0]!.index, 0);
    assert.equal(entries[1]!.index, 1);
    assert.equal(entries[2]!.index, 2);
  });
});

describe('tokenizeGeneric', () => {
  it('splits text by blank-line paragraphs', () => {
    const input = 'Paragraph one.\nStill paragraph one.\n\nParagraph two.';
    const entries = tokenizeGeneric(input);
    assert.equal(entries.length, 2);
    assert.ok(entries[0]!.text.includes('Paragraph one'));
    assert.ok(entries[1]!.text === 'Paragraph two.');
  });

  it('filters empty paragraphs', () => {
    const entries = tokenizeGeneric('\n\n\n\nhello\n\n\n');
    assert.equal(entries.length, 1);
    assert.equal(entries[0]!.text, 'hello');
  });
});
