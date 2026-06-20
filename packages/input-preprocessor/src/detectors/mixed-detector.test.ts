/**
 * mixed-detector.test.ts — Tests for mixed content type detection.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createMixedDetector } from './mixed-detector.js';

const detector = createMixedDetector();

describe('createMixedDetector', () => {
  it('detects interleaved log + error', () => {
    const input = [
      '[14:32:01] INFO Starting server on port 3000',
      '[14:32:02] DEBUG Loading configuration',
      '[14:32:03] INFO Server started',
      '',
      'Error: Failed to connect',
      '    at Module.connect (/app/src/db.ts:42:15)',
      '    at async Server.start (/app/src/server.ts:108:22)',
      '',
      '[14:32:04] WARN Retry attempt 1 of 3',
      '[14:32:05] ERROR Connection refused',
    ].join('\n');
    const result = detector.detect(input);
    assert.ok(result);
    assert.equal(result!.type, 'mixed');
    assert.ok(result!.confidence >= 0.6);
    assert.ok(result!.secondary && result!.secondary.length >= 1);
  });

  it('detects interleaved code + config', () => {
    const input = [
      'import { readFileSync } from "node:fs";',
      'import { join } from "node:path";',
      'import { loadConfig } from "./config.js";',
      'const args = process.argv.slice(2);',
      '',
      'name: my-app',
      'version: 1.0.0',
      'port: 3000',
      'description: A sample app',
      'settings:',
      '  timeout: 5000',
      '',
      'console.log("Starting app...");',
      'const config = readFileSync(args[0], "utf-8");',
      'export function main() { return config; }',
    ].join('\n');
    const result = detector.detect(input);
    assert.ok(result);
    assert.equal(result!.type, 'mixed');
  });

  it('returns null for single-type content', () => {
    const input = [
      '[14:32:01] INFO Starting server',
      '[14:32:02] DEBUG Loading config',
      '[14:32:03] INFO Server started',
      '[14:32:04] WARN Low memory',
      '[14:32:05] ERROR Connection failed',
      '[14:32:06] INFO Retrying',
      '[14:32:07] INFO Connected',
    ].join('\n');
    const result = detector.detect(input);
    assert.equal(result, null);
  });

  it('returns null for short input', () => {
    const input = 'short\ninput';
    const result = detector.detect(input);
    assert.equal(result, null);
  });

  it('returns null when segments are too small', () => {
    const input = [
      'a',
      '',
      'b',
      '',
      'c',
    ].join('\n');
    const result = detector.detect(input);
    assert.equal(result, null);
  });
});
