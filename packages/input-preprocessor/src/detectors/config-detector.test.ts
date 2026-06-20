/**
 * config-detector.test.ts — Tests for configuration content type detection.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createConfigDetector } from './config-detector.js';

const detector = createConfigDetector();

describe('createConfigDetector', () => {
  it('detects valid JSON with high confidence', () => {
    const input = JSON.stringify({
      name: 'my-app',
      version: '1.0.0',
      dependencies: { express: '^4.18.0', pg: '^8.11.0' },
      scripts: { start: 'node index.js', test: 'node --test' },
    }, null, 2);
    const result = detector.detect(input);
    assert.ok(result);
    assert.equal(result!.type, 'config');
    assert.ok(result!.confidence >= 0.9);
  });

  it('detects partial JSON with quoted keys', () => {
    const input = [
      '{',
      '  "name": "my-app",',
      '  "version": "1.0.0",',
      '  "dependencies": {',
      '    "express": "^4.18.0",',
      '    "pg": "^8.11.0"',
      '  }',
      '}',
    ].join('\n');
    const result = detector.detect(input);
    assert.ok(result);
    assert.equal(result!.type, 'config');
    assert.ok(result!.confidence >= 0.65);
  });

  it('detects YAML key-value patterns with high confidence', () => {
    const input = [
      'name: my-app',
      'version: 1.0.0',
      'description: A sample application',
      'dependencies:',
      '  express: ^4.18.0',
      '  pg: ^8.11.0',
      'scripts:',
      '  start: node index.js',
      '  test: node --test',
    ].join('\n');
    const result = detector.detect(input);
    assert.ok(result);
    assert.equal(result!.type, 'config');
    assert.ok(result!.confidence >= 0.7);
  });

  it('detects INI/TOML section headers', () => {
    const input = [
      '[server]',
      'host = "localhost"',
      'port = 3000',
      '',
      '[database]',
      'url = "postgres://localhost:5432/mydb"',
      'pool_size = 10',
    ].join('\n');
    const result = detector.detect(input);
    assert.ok(result);
    assert.equal(result!.type, 'config');
    assert.ok(result!.confidence >= 0.7);
  });

  it('detects .env-style KEY=VALUE with high confidence', () => {
    const input = [
      'DATABASE_URL=postgres://localhost:5432/mydb',
      'PORT=3000',
      'HOST=0.0.0.0',
      'DEBUG=true',
      'NODE_ENV=production',
      'LOG_LEVEL=info',
    ].join('\n');
    const result = detector.detect(input);
    assert.ok(result);
    assert.equal(result!.type, 'config');
    assert.ok(result!.confidence >= 0.75);
  });

  it('detects XML/HTML structure', () => {
    const input = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<project xmlns="http://maven.apache.org/POM/4.0.0">',
      '  <modelVersion>4.0.0</modelVersion>',
      '  <groupId>com.example</groupId>',
      '  <artifactId>my-app</artifactId>',
      '  <version>1.0.0</version>',
      '</project>',
    ].join('\n');
    const result = detector.detect(input);
    assert.ok(result);
    assert.equal(result!.type, 'config');
  });

  it('returns null for plain text', () => {
    const input = 'This is just a plain text description\nwith no config patterns.\nJust regular sentences.';
    const result = detector.detect(input);
    assert.equal(result, null);
  });

  it('returns null for short input', () => {
    const input = '{ "key": "value" }';
    const result = detector.detect(input);
    assert.equal(result, null);
  });

  it('detects sparse YAML-like patterns with low confidence', () => {
    const input = Array.from({ length: 15 }, (_, i) => {
      if (i < 3) return `key${i}: value${i}`;
      return `line ${i} of description text`;
    }).join('\n');
    const result = detector.detect(input);
    // 3 YAML lines out of 15 → ratio 0.2 → above 0.15 threshold.
    assert.ok(result);
    assert.equal(result!.type, 'config');
    assert.ok(result!.confidence >= 0.4);
  });
});
