import assert from 'node:assert/strict';
import test from 'node:test';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  _buildGrokArgs,
  _redactGrokOutput,
  spawnGrok,
} from './grok.js';

test('Grok runtime arguments keep model and permission mode fixed', () => {
  assert.deepEqual(_buildGrokArgs('inspect this workspace'), [
    '--single', 'inspect this workspace',
    '--model', 'grok-4.5',
    '--permission-mode', 'dontAsk',
  ]);
});

test('Grok runtime output redacts known credential shapes', () => {
  const output = _redactGrokOutput([
    '{"access_token":"xai-secret","refresh_token":"refresh-secret","key":"opaque-secret"}',
    'Authorization: Bearer token-value-12345678',
    'XAI_API_KEY=sk-xai-secret-value',
    'eyJheader.payload.signature',
  ].join('\n'));

  assert.doesNotMatch(output, /xai-secret|refresh-secret|opaque-secret|token-value|sk-xai|eyJheader/);
  assert.match(output, /\[redacted\]/);
});

test('Grok runtime captures bounded stdout and never returns stderr', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'los-grok-runtime-'));
  const executable = join(dir, 'grok-fixture');
  writeFileSync(executable, [
    '#!/bin/sh',
    'printf \'%s\' \'{"access_token":"fixture-secret"}abcdefghijk\'',
    'printf \'%s\' \'raw-stderr-must-not-return\' >&2',
  ].join('\n'), { mode: 0o700 });
  chmodSync(executable, 0o700);

  try {
    const handle = spawnGrok({
      prompt: 'fixture prompt',
      workspaceRoot: dir,
      grokPath: executable,
      outputLimitBytes: 48,
      timeoutMs: 5_000,
    });
    const [exit, output] = await Promise.all([handle.exited, handle.output]);

    assert.equal(exit.exitCode, 0);
    assert.equal(output.stderrBytes, Buffer.byteLength('raw-stderr-must-not-return'));
    assert.equal(output.text.includes('raw-stderr-must-not-return'), false);
    assert.equal(output.text.includes('fixture-secret'), false);
    assert.ok(output.capturedBytes <= 48);
    assert.equal(output.totalBytes > 0, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Grok runtime marks output truncated at the configured byte bound', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'los-grok-runtime-limit-'));
  const executable = join(dir, 'grok-fixture');
  writeFileSync(executable, '#!/bin/sh\nprintf \'1234567890abcdefghij\'\n', { mode: 0o700 });
  chmodSync(executable, 0o700);

  try {
    const output = await spawnGrok({
      prompt: 'fixture prompt',
      workspaceRoot: dir,
      grokPath: executable,
      outputLimitBytes: 10,
      timeoutMs: 5_000,
    }).output;
    assert.equal(output.text, '1234567890');
    assert.equal(output.capturedBytes, 10);
    assert.equal(output.totalBytes, 20);
    assert.equal(output.truncated, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
