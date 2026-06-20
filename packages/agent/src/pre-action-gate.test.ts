import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  preActionGate,
  failureFingerprintFromError,
  extractFragilitySignal,
} from './pre-action-gate.js';

describe('pre-action-gate', () => {
  it('returns safe:true and empty warnings when no patterns match', () => {
    const result = preActionGate('read', { file_path: 'src/foo.ts' });
    assert.equal(result.safe, true);
    assert.deepEqual(result.warnings, []);
    assert.equal(result.knownFailure, false);
    assert.equal(result.fragileFile, false);
  });

  it('detects known failure fingerprint for the same tool + file', () => {
    const failureFingerprints = new Set(['write::src/foo.ts']);
    const result = preActionGate('write', { file_path: 'src/foo.ts' }, { failureFingerprints });
    assert.equal(result.safe, false);
    assert.equal(result.knownFailure, true);
    assert.ok(result.warnings.length >= 1);
    assert.ok(result.warnings[0].includes('previously failed'));
  });

  it('detects fragile files', () => {
    const fragileFiles = new Set(['src/fragile.ts', 'src/legacy/app.ts']);
    const result = preActionGate('write_edit', { file_path: 'src/fragile.ts' }, { fragileFiles });
    assert.equal(result.safe, true);
    assert.equal(result.fragileFile, true);
    assert.ok(result.warnings.length >= 1);
    assert.ok(result.warnings[0].includes('Fragile file'));
  });

  it('detects both known failure and fragile file', () => {
    const fragileFiles = new Set(['src/bad.ts']);
    const fingerprints = new Set(['write::src/bad.ts']);
    const result = preActionGate('write', { file_path: 'src/bad.ts' }, { fragileFiles, failureFingerprints: fingerprints });
    assert.equal(result.safe, false);
    assert.equal(result.knownFailure, true);
    assert.equal(result.fragileFile, true);
    assert.ok(result.warnings.length >= 2);
  });

  it('warns about writing in a directory with fragile siblings', () => {
    const fragileFiles = new Set(['src/components/Broken.tsx']);
    const result = preActionGate('write_edit', { file_path: 'src/components/NewOne.tsx' }, { fragileFiles });
    assert.equal(result.safe, true);
    assert.ok(result.warnings.length >= 1);
    assert.ok(result.warnings[0].includes('fragile files'));
  });

  it('flags fragile file even for read tools (informational)', () => {
    const fragileFiles = new Set(['src/components/Broken.tsx']);
    const result = preActionGate('read', { file_path: 'src/components/Broken.tsx' }, { fragileFiles });
    // Fragile file is flagged (for awareness) but safe=true since it's a read
    assert.equal(result.fragileFile, true);
    assert.equal(result.safe, true);
    assert.equal(result.knownFailure, false);
  });

  it('builds fingerprint from file_path', () => {
    const fp = failureFingerprintFromError('write_edit', { file_path: 'src/foo.ts' }, 'TypeError');
    assert.equal(fp, 'write_edit::src/foo.ts');
  });

  it('builds fingerprint from path field', () => {
    const fp = failureFingerprintFromError('replace', { path: 'src/bar.ts' }, 'ENOENT');
    assert.equal(fp, 'replace::src/bar.ts');
  });

  it('builds fingerprint from file field', () => {
    const fp = failureFingerprintFromError('write', { file: 'src/baz.ts' }, 'perm error');
    assert.equal(fp, 'write::src/baz.ts');
  });

  it('falls back to tool + arg fingerprint when no file-like arg', () => {
    const fp = failureFingerprintFromError('bash', { command: 'npm test' }, 'exit code 1');
    assert.equal(fp, 'bash::command::npm test');
  });

  it('handles empty args gracefully', () => {
    const result = preActionGate('read', {});
    assert.equal(result.safe, true);
    assert.deepEqual(result.warnings, []);
  });

  describe('extractFragilitySignal', () => {
    it('extracts fragile files from failed tool calls', () => {
      const events = [
        { toolName: 'write', args: { file_path: 'src/broken.ts' }, ok: false, denied: false, error: 'OOM' },
        { toolName: 'bash', args: { command: 'build' }, ok: false, denied: false, error: 'exit 1' },
      ];
      const signal = extractFragilitySignal(events);
      assert.equal(signal.fragileFiles.has('src/broken.ts'), true);
      assert.equal(signal.failureFingerprints.has('write::src/broken.ts'), true);
    });

    it('ignores successful tool calls', () => {
      const events = [
        { toolName: 'write', args: { file_path: 'src/ok.ts' }, ok: true, denied: false },
      ];
      const signal = extractFragilitySignal(events);
      assert.equal(signal.fragileFiles.size, 0);
    });
  });
});
