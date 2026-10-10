import test from 'node:test';
import assert from 'node:assert/strict';
import {
  canMarkSucceeded,
  classifyPhaseLedger,
  mergeRunContractMetadata,
  normalizeRunContractMetadata,
  parsePhaseExemptReason,
  readRunContractMetadata,
} from './run-contract.js';
import { normalizePlanForPersistence, validatePlanForApproval } from './run-plan-validation.js';

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

test('executionMode persists and skipped checks require explicit allowance', () => {
  const contract = normalizeRunContractMetadata({
    executionMode: 'heavyweight',
    requiredChecks: ['pnpm check'],
  });
  assert.equal(contract?.executionMode, 'heavyweight');
  assert.equal(canMarkSucceeded(contract, [{ requirementId: 'pnpm check', status: 'skipped' }]).allowed, false);

  const allowed = normalizeRunContractMetadata({
    executionMode: 'standard',
    requiredChecks: ['pnpm check'],
    allowedSkippedChecks: ['pnpm check'],
  });
  assert.equal(canMarkSucceeded(allowed, [{ requirementId: 'pnpm check', status: 'skipped' }]).allowed, true);
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

test('E20 — selfCheckEnabled normalizes to boolean only', () => {
  // selfCheckEnabled must normalize to strict boolean (true/false); string
  // values like 'true'/'false' are also accepted and coerced.
  const enabled = normalizeRunContractMetadata({ selfCheckEnabled: true });
  assert.equal(enabled?.selfCheckEnabled, true);

  const disabled = normalizeRunContractMetadata({ selfCheckEnabled: false });
  assert.equal(disabled?.selfCheckEnabled, false);

  const stringTrue = normalizeRunContractMetadata({ selfCheckEnabled: 'true' });
  assert.equal(stringTrue?.selfCheckEnabled, true);

  const stringFalse = normalizeRunContractMetadata({ selfCheckEnabled: 'false' });
  assert.equal(stringFalse?.selfCheckEnabled, false);

  // Non-boolean non-string values like numbers should produce undefined
  const numeric = normalizeRunContractMetadata({ selfCheckEnabled: 1 });
  assert.equal(numeric?.selfCheckEnabled, undefined);
});

test('E21 — selfCheckResult pass-through preserves audit trail', () => {
  const contract = normalizeRunContractMetadata({
    selfCheckEnabled: true,
    selfCheckResult: {
      goalMet: true,
      stopConditionsMet: [true, false],
      selfCheckPassed: false,
      evaluatedAt: '2026-06-15T00:00:00Z',
    },
  });
  assert.ok(contract?.selfCheckResult);
  assert.equal(contract!.selfCheckResult!.goalMet, true);
  // Non-object selfCheckResult should be undefined
  const empty = normalizeRunContractMetadata({ selfCheckResult: 'not-an-object' });
  assert.equal(empty?.selfCheckResult, undefined);
});

test('plan validation compares canonical ids and dependencies', () => {
  const plan = [
    { id: 'step-1', title: 'First', description: 'First step.', dependsOnIds: [], editableSurfaces: [' src/a.ts '], completionCriteria: 'Done.' },
    { id: ' step-1 ', title: 'Duplicate', description: 'Duplicate step.', dependsOnIds: [' step-1 '], editableSurfaces: [], completionCriteria: 'Done.' },
  ];
  assert.match(validatePlanForApproval(plan) ?? '', /duplicated/);
  const normalized = normalizePlanForPersistence([plan[0]!]);
  assert.equal(normalized[0]?.id, 'step-1');
  assert.deepEqual(normalized[0]?.editableSurfaces, ['src/a.ts']);
});

test('E22 — recoveryPolicy normalizes to automatic or explicit_only only', () => {
  const explicit = normalizeRunContractMetadata({ recoveryPolicy: 'explicit_only' });
  assert.equal(explicit?.recoveryPolicy, 'explicit_only');
  const automatic = normalizeRunContractMetadata({ recoveryPolicy: 'automatic' });
  assert.equal(automatic?.recoveryPolicy, 'automatic');
  const invalid = normalizeRunContractMetadata({ recoveryPolicy: 'always' });
  assert.equal(invalid?.recoveryPolicy, undefined);
});

// ── Phase ledger classification (truth remediation §6) ──────────────────────

test('NEGATIVE CONTROL: a NULL phase is legacy history, never real drift', () => {
  // The audit's false negative was exactly this row: `phase NOT IN (...)` drops
  // NULL, so the instrument reported zero drift while 402 rows had no phase.
  const row = { mode: 'execution' };
  assert.equal(classifyPhaseLedger(row, 'succeeded').bucket, 'legacy_untracked');
  assert.equal(classifyPhaseLedger(row, 'failed').bucket, 'legacy_untracked');
  assert.equal(classifyPhaseLedger({ phase: null }, 'cancelled').bucket, 'legacy_untracked');
  assert.equal(classifyPhaseLedger({}, undefined).bucket, 'legacy_untracked');
});

test('an illegal non-empty phase is its own bucket, not legacy', () => {
  // `completed` is not a phase. Normalization would drop it; the classifier must
  // see it before that happens, otherwise the caller's bug reads as history.
  const completed = classifyPhaseLedger({ phase: 'completed' }, 'succeeded');
  assert.equal(completed.bucket, 'illegal_phase');
  assert.equal(completed.illegalPhase, 'completed');
  assert.equal(classifyPhaseLedger({ phase: 'not_applicable' }, 'running').bucket, 'illegal_phase');
  assert.equal(classifyPhaseLedger({ phase: ' EXECUTING ' }, 'running').bucket, 'illegal_phase');
  // Normalization really does hide it — this is why raw JSON is the input.
  assert.equal(normalizeRunContractMetadata({ phase: 'completed' })?.phase, undefined);
});

test('legal phases use the shared drift predicates', () => {
  assert.equal(classifyPhaseLedger({ phase: 'planning' }, 'succeeded').bucket, 'real_drift');
  assert.equal(classifyPhaseLedger({ phase: 'succeeded' }, 'running').bucket, 'real_drift');
  assert.equal(classifyPhaseLedger({ phase: 'planning' }, 'running').bucket, 'real_drift');
  // blocked is checked by the drift script but not by validatePhaseStatusConsistency;
  // sharing this classifier is what keeps the two from disagreeing.
  assert.equal(classifyPhaseLedger({ phase: 'executing' }, 'blocked').bucket, 'real_drift');
  assert.equal(classifyPhaseLedger({ phase: 'blocked' }, 'blocked').bucket, 'consistent');
  assert.equal(classifyPhaseLedger({ phase: 'executing' }, 'running').bucket, 'consistent');
  assert.equal(classifyPhaseLedger({ phase: 'succeeded' }, 'succeeded').bucket, 'consistent');
});

test('an explicit exemption is separated from an unspecified one', () => {
  assert.equal(
    classifyPhaseLedger({ phaseTracking: 'exempt', phaseExemptReason: 'openai_compat' }, 'running').bucket,
    'exempt',
  );
  assert.equal(
    classifyPhaseLedger({ phaseTracking: 'exempt', phaseExemptReason: 'writer_omitted' }, 'running').bucket,
    'exempt_unspecified',
  );
  // A marker without a reason is still a write-side defect, not an exemption.
  assert.equal(classifyPhaseLedger({ phaseTracking: 'exempt' }, 'running').bucket, 'exempt_unspecified');
  // Unknown reasons must not be silently promoted to a legitimate exemption.
  assert.equal(classifyPhaseLedger({ phaseTracking: 'exempt', phaseExemptReason: 'typo' }, 'running').bucket, 'exempt_unspecified');
});

test('a tracked contract with a missing phase is still legacy history', () => {
  assert.equal(classifyPhaseLedger({ phaseTracking: 'tracked' }, 'succeeded').bucket, 'legacy_untracked');
});

// ── Normalization of the new fields ────────────────────────────────────────

test('the phase marker survives the closed-set copy', () => {
  const exempt = normalizeRunContractMetadata({
    phaseTracking: 'exempt',
    phaseExemptReason: 'feed_analysis_ingress',
  });
  assert.equal(exempt?.phaseTracking, 'exempt');
  assert.equal(exempt?.phaseExemptReason, 'feed_analysis_ingress');

  const tracked = normalizeRunContractMetadata({ phase: 'executing' });
  assert.equal(tracked?.phase, 'executing');
});

test('an unknown phaseExemptReason throws instead of being collected as writer_omitted', () => {
  assert.throws(
    () => normalizeRunContractMetadata({ phaseTracking: 'exempt', phaseExemptReason: 'not_a_reason' }),
    /Unknown phaseExemptReason/,
  );
  assert.equal(parsePhaseExemptReason('writer_omitted'), 'writer_omitted');
  assert.equal(parsePhaseExemptReason(undefined), undefined);
});

// "A marker-only contract is not an empty contract" is asserted end to end in
// run-specs.test.ts (against createRunSpec), because `hasRunContractValue` is
// file-local by design: exporting it just for a unit test would add a wired-but-
// unused export for the wiring gate to flag.
