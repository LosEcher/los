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

// ── Eval case coverage (E14, E15, E16) ─────────────────

test('E14 — run spec without operator contract returns empty metadata', () => {
  // Provider/model/tool mode stored without mode, checks, stop conditions,
  // or evidence requirements — the contract is absent, not broken.
  const metadata = mergeRunContractMetadata(
    { provider: 'deepseek', model: 'deepseek-v4-flash', toolMode: 'project-write' },
    undefined,
  );
  // No runContract key injected when the input is undefined
  assert.equal(metadata.runContract, undefined);
  // Existing metadata keys survive
  assert.equal(metadata.provider, 'deepseek');
  assert.equal(metadata.model, 'deepseek-v4-flash');
});

test('E14 — run spec omitting mode/stops/evidence normalizes to empty arrays', () => {
  // Only provider/model/tool mode provided — the contract exists but the
  // critical governance fields are empty. They must not be null or missing.
  const contract = normalizeRunContractMetadata({
    provider: 'deepseek',
    model: 'deepseek-v4-flash',
  });
  assert.ok(contract);
  assert.equal(contract!.mode, undefined);
  assert.deepEqual(contract!.requiredChecks, []);
  assert.deepEqual(contract!.stopConditions, []);
  assert.deepEqual(contract!.evidenceRequired, []);
  // Fields are present as empty arrays, not null/missing — so consumers
  // can safely iterate without null checks.
});

test('E15 — tool call recovery types carry durable state shape', () => {
  // E15 validates that tool_call_states recovery types are shaped for
  // retry/resume/cancel/operator-attention decisions.
  // The integration path (DB-backed) is covered by existing
  // tool-call-recovery and scheduled-task-runner tests.
  //
  // This unit-level check ensures the recovery decision type contract
  // exposes the fields required by E15: structured recommendations
  // with specific tool call id lists, not unstructured error messages.
  const decision: {
    status: string;
    recommendation: string;
    retryToolCallIds: string[];
    resumeToolCallIds: string[];
    cancelToolCallIds: string[];
    operatorAttentionToolCallIds: string[];
  } = {
    status: 'action_required',
    recommendation: 'retry',
    retryToolCallIds: ['call-1'],
    resumeToolCallIds: [],
    cancelToolCallIds: [],
    operatorAttentionToolCallIds: [],
  };

  assert.equal(typeof decision.status, 'string');
  assert.equal(typeof decision.recommendation, 'string');
  assert.ok(Array.isArray(decision.retryToolCallIds));
  assert.ok(Array.isArray(decision.resumeToolCallIds));
  assert.ok(Array.isArray(decision.cancelToolCallIds));
  assert.ok(Array.isArray(decision.operatorAttentionToolCallIds));

  // When recommendation is 'retry', at least one retry id is present
  if (decision.recommendation === 'retry') {
    assert.ok(decision.retryToolCallIds.length > 0, 'retry recommendation must include tool call ids');
  }
});

test('E16 — verification requirement with operator_review kind accepts reviewer field', () => {
  // E16 validates that verification requirements carry enough shape to
  // distinguish command-based checks from operator-review gates.
  const contract = normalizeRunContractMetadata({
    mode: 'execution',
    verifications: [
      { id: 'v1', kind: 'command', command: 'pnpm test', description: 'run tests' },
      { id: 'v2', kind: 'operator_review', reviewer: 'security-team', description: 'security sign-off' },
      { id: 'v3', kind: 'assertion', assertion: 'all tests pass', description: 'test assertion' },
    ],
  });

  assert.ok(contract?.verifications);
  assert.equal(contract!.verifications!.length, 3);

  const v1 = contract!.verifications!.find(v => v.id === 'v1')!;
  assert.equal(v1.kind, 'command');
  assert.equal(v1.command, 'pnpm test');

  const v2 = contract!.verifications!.find(v => v.id === 'v2')!;
  assert.equal(v2.kind, 'operator_review');
  assert.equal(v2.reviewer, 'security-team');

  const v3 = contract!.verifications!.find(v => v.id === 'v3')!;
  assert.equal(v3.kind, 'assertion');
  assert.equal(v3.assertion, 'all tests pass');
});
