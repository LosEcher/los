import test from 'node:test';
import assert from 'node:assert/strict';

import { loadConfig } from '@los/infra/config';
import { closeDb, getDb, initDb } from '@los/infra/db';
import { recordProviderCompatEvidence } from './provider-compat-evidence.js';
import {
  ensureProviderPromotionDecisionStore,
  listProviderPromotionDecisions,
  recordProviderPromotionDecision,
} from './provider-promotion-decisions.js';

test('provider promotion decisions record proposed required-gate policy changes', async () => {
  const config = await loadConfig();
  await initDb(config.databaseUrl);
  const provider = `provider-policy-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const passedEvidenceId = `${provider}-verified`;
  const failedEvidenceId = `${provider}-failed`;
  try {
    await ensureProviderPromotionDecisionStore();
    await recordProviderCompatEvidence({
      id: passedEvidenceId,
      provider,
      model: 'model-a',
      probeId: 'read-context',
      targetLabel: `${provider}:model-a`,
      decision: 'verified_advisory',
      passed: true,
      sessionId: `session-${provider}`,
      taskRunId: `task-${provider}`,
      totalTokens: 99,
    });
    await recordProviderCompatEvidence({
      id: failedEvidenceId,
      provider,
      model: 'model-b',
      probeId: 'read-context',
      targetLabel: `${provider}:model-b`,
      decision: 'advisory',
      passed: false,
      summary: { failures: ['expected tool missing'] },
    });

    const promote = await recordProviderPromotionDecision({
      id: `${provider}-promote`,
      action: 'promote_required',
      evidenceId: passedEvidenceId,
      reason: 'policy smoke promotes verified advisory evidence',
      actor: 'test',
    });
    assert.equal(promote.status, 'proposed');
    assert.equal(promote.provider, provider);
    assert.equal(promote.model, 'model-a');
    assert.equal(promote.fromDecision, 'verified_advisory');
    assert.equal(promote.toDecision, 'required');
    assert.equal(promote.evidenceId, passedEvidenceId);

    await assert.rejects(
      () => recordProviderPromotionDecision({
        action: 'promote_required',
        evidenceId: failedEvidenceId,
        reason: 'should fail',
      }),
      /did not pass/,
    );

    const demote = await recordProviderPromotionDecision({
      id: `${provider}-demote`,
      action: 'demote_advisory',
      provider,
      model: 'model-a',
      probeId: 'read-context',
      reason: 'required gate is too expensive for default checks',
    });
    assert.equal(demote.status, 'proposed');
    assert.equal(demote.fromDecision, 'required');
    assert.equal(demote.toDecision, 'advisory');

    const history = await listProviderPromotionDecisions({ provider, limit: 10 });
    assert.equal(history.length, 2);
    assert.ok(history.some(item => item.action === 'promote_required'));
    assert.ok(history.some(item => item.action === 'demote_advisory'));
  } finally {
    await getDb().query('DELETE FROM provider_promotion_decisions WHERE provider = $1', [provider]).catch(() => undefined);
    await getDb().query('DELETE FROM provider_compat_evidence WHERE provider = $1', [provider]).catch(() => undefined);
    await closeDb().catch(() => undefined);
  }
});
