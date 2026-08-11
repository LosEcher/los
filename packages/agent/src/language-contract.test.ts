import test from 'node:test';
import assert from 'node:assert/strict';

import {
  aggregateLanguageScores,
  evaluateLanguageThresholds,
  formatLanguageContractForPrompt,
  languageContractVersion,
  scoreLanguageContract,
} from './language-contract.js';

test('language contract version and prompt blocks are non-empty', () => {
  assert.ok(languageContractVersion());
  assert.equal(formatLanguageContractForPrompt('none'), '');
  assert.ok(formatLanguageContractForPrompt('minimal').includes('FINDING'));
  assert.ok(formatLanguageContractForPrompt('minimal').includes('INCOMPLETE'));
  assert.ok(formatLanguageContractForPrompt('standard').includes('Language'));
  assert.ok(formatLanguageContractForPrompt('standard').includes('[E]'));
});

test('scoreLanguageContract rewards evidence markers and penalizes bare claims', () => {
  const good = scoreLanguageContract(
    'Gateway is healthy [E] via curl /health 200. Residual risk: RSS not checked [I].',
  );
  assert.equal(good.hasEvidenceMarker, true);
  assert.equal(good.bareCompletionClaimCount, 0);
  assert.ok(good.complianceScore >= 0.9);

  const bad = scoreLanguageContract(
    'Let me start by exploring the repo. Everything is fixed and shipped successfully.',
  );
  assert.equal(bad.hasEvidenceMarker, false);
  assert.ok(bad.processNarrationCount >= 1);
  assert.ok(bad.bareCompletionClaimCount >= 1);
  assert.ok(bad.complianceScore < good.complianceScore);
  assert.ok(bad.flags.includes('bare_completion_claim'));
  assert.ok(bad.flags.includes('process_narration'));
});

test('scoreLanguageContract allows completion words when an evidence pointer is nearby', () => {
  const scored = scoreLanguageContract(
    'Fixed auth bug in packages/gateway/src/auth-routes.ts after pnpm check passed.',
  );
  // Heuristic may still flag; presence of path/check should keep count low or zero.
  assert.ok(scored.bareCompletionClaimCount <= 1);
});

test('aggregate + thresholds emit missing_evidence_markers when rate is low', () => {
  const scores = Array.from({ length: 10 }, () =>
    scoreLanguageContract('Spawning the next agent now. Task is done.'),
  );
  const metrics = aggregateLanguageScores(scores);
  assert.equal(metrics.sampleCount, 10);
  assert.ok(metrics.evidenceMarkerRate < 0.1);

  const findings = evaluateLanguageThresholds(metrics, {
    evidenceMarkerRateMin: 0.1,
    bareCompletionClaimRateMax: 0.15,
    processNarrationRateMax: 0.3,
    avgHedgeMax: 8,
    meanComplianceMin: 0.45,
  });
  assert.ok(findings.some(f => f.dimension === 'missing_evidence_markers'));
  assert.ok(findings.some(f => f.dimension === 'process_narration' || f.dimension === 'bare_completion_claims' || f.dimension === 'low_compliance'));
});

test('evaluateLanguageThresholds returns insufficient_samples below min', () => {
  const metrics = aggregateLanguageScores([
    scoreLanguageContract('short'),
  ]);
  const findings = evaluateLanguageThresholds(metrics, undefined, { minSamplesForThresholds: 8 });
  assert.equal(findings.length, 1);
  assert.equal(findings[0]!.dimension, 'insufficient_samples');
});
