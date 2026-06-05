import test from 'node:test';
import assert from 'node:assert/strict';

import {
  mergeRunContractMetadata,
  normalizeRunContractMetadata,
  readRunContractMetadata,
} from './run-contract.js';

test('normalizeRunContractMetadata trims, deduplicates, and rejects invalid mode', () => {
  const contract = normalizeRunContractMetadata({
    mode: 'execution',
    goal: '  wire contract metadata  ',
    editableSurfaces: ['packages/agent', 'packages/agent', ''],
    requiredChecks: 'pnpm check, pnpm test, pnpm check',
    allowedSkippedChecks: [' docs smoke '],
    stopConditions: ['destructive vcs', null],
    evidenceRequired: ['diff', 'tests'],
    rawEvidenceProhibited: ['raw transcripts', 'auth snapshots'],
  });

  assert.equal(contract?.mode, 'execution');
  assert.equal(contract?.goal, 'wire contract metadata');
  assert.deepEqual(contract?.editableSurfaces, ['packages/agent']);
  assert.deepEqual(contract?.requiredChecks, ['pnpm check', 'pnpm test']);
  assert.deepEqual(contract?.allowedSkippedChecks, ['docs smoke']);
  assert.deepEqual(contract?.stopConditions, ['destructive vcs']);
  assert.deepEqual(contract?.evidenceRequired, ['diff', 'tests']);
  assert.deepEqual(contract?.rawEvidenceProhibited, ['raw transcripts', 'auth snapshots']);

  const invalid = normalizeRunContractMetadata({ mode: 'yolo' });
  assert.equal(invalid, undefined);
});

test('mergeRunContractMetadata stores contract under metadata.runContract', () => {
  const metadata = mergeRunContractMetadata(
    { existing: true },
    {
      mode: 'audit',
      requiredChecks: ['read-only review'],
      evidenceRequired: ['file paths'],
    },
  );

  assert.equal(metadata.existing, true);
  assert.deepEqual(readRunContractMetadata(metadata), {
    mode: 'audit',
    editableSurfaces: [],
    requiredChecks: ['read-only review'],
    allowedSkippedChecks: [],
    stopConditions: [],
    evidenceRequired: ['file paths'],
    externalEvidenceAllowed: [],
    rawEvidenceProhibited: [],
  });
});
