/**
 * code-detector.test.ts — Tests for code content type detection.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createCodeDetector } from './code-detector.js';

const detector = createCodeDetector();

describe('createCodeDetector', () => {
  it('detects shebang with high confidence', () => {
    const input = [
      '#!/usr/bin/env node',
      'const x = require("foo");',
      'console.log("hello");',
    ].join('\n');
    const result = detector.detect(input);
    assert.ok(result);
    assert.equal(result!.type, 'code');
    assert.ok(result!.confidence >= 0.9);
  });

  it('detects JS/TS imports', () => {
    const input = [
      'import { foo } from "./bar";',
      'import type { Baz } from "./baz";',
      'const x: string = "hello";',
      'export function main() { return x; }',
    ].join('\n');
    const result = detector.detect(input);
    assert.ok(result);
    assert.equal(result!.type, 'code');
    assert.ok(result!.confidence >= 0.7);
  });

  it('detects Python imports', () => {
    const input = [
      'from typing import List, Optional',
      'import os',
      'import sys',
      'def main():',
      '    print("hello")',
      'if __name__ == "__main__":',
      '    main()',
    ].join('\n');
    const result = detector.detect(input);
    assert.ok(result);
    assert.equal(result!.type, 'code');
    assert.ok(result!.confidence >= 0.7);
  });

  it('detects code by keyword density', () => {
    const input = Array.from({ length: 30 }, (_, i) => {
      if (i % 5 === 0) return `function foo${i}() { return ${i}; }`;
      if (i % 5 === 1) return `const x${i} = await bar(${i});`;
      if (i % 5 === 2) return `if (x${i} > 0) { continue; }`;
      if (i % 5 === 3) return `class Thing${i} { private val: number; }`;
      return `export default ${i};`;
    }).join('\n');
    const result = detector.detect(input);
    assert.ok(result);
    assert.equal(result!.type, 'code');
    assert.ok(result!.confidence >= 0.65);
  });

  it('detects code by indentation + keywords', () => {
    const input = [
      'const config = {',
      '  port: 3000,',
      '  host: "localhost",',
      '};',
      'function start() {',
      '  console.log("starting");',
      '  if (!config.port) {',
      '    throw new Error("no port");',
      '  }',
      '}',
      'start();',
    ].join('\n');
    const result = detector.detect(input);
    assert.ok(result);
    assert.equal(result!.type, 'code');
  });

  it('detects Go/Rust code patterns', () => {
    const input = [
      'package main',
      'import (',
      '    "fmt"',
      '    "os"',
      ')',
      'func main() {',
      '    fmt.Println("hello")',
      '}',
    ].join('\n');
    const result = detector.detect(input);
    assert.ok(result);
    assert.equal(result!.type, 'code');
    assert.ok(result!.confidence >= 0.7);
  });

  it('returns null for plain text', () => {
    const input = 'This is just a plain text description\nwith no code patterns at all.\nJust regular sentences.';
    const result = detector.detect(input);
    assert.equal(result, null);
  });

  it('returns null for short input', () => {
    const input = 'function foo() {}';
    const result = detector.detect(input);
    assert.equal(result, null);
  });

  it('detects sparse code with moderate confidence', () => {
    const input = [
      '// This is a config file',
      '// Generated on 2024-01-15',
      '// Do not edit manually',
      '',
      'const API_URL = process.env.API_URL || "http://localhost:3000";',
      'const DEBUG = true;',
      '',
      'module.exports = { API_URL, DEBUG };',
    ].join('\n');
    const result = detector.detect(input);
    // 3 comment lines of 6 non-empty (50%) + sparse keywords → heuristic 5 triggers at 0.45.
    assert.ok(result);
    assert.equal(result!.type, 'code');
    assert.ok(result!.confidence >= 0.4 && result!.confidence <= 0.65);
  });
});
