import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createServer } from 'node:http';
import { getDb } from '@los/infra/db';
import {
  createOrLoadFeedAnalysisDispatch,
  emitFeedAnalysisStatus,
  ensureFeedAnalysisStore,
  loadFeedAnalysisDispatch,
  loadFeedAnalysisResult,
  pruneExpiredFeedAnalysisMaterial,
  saveFeedAnalysisResult,
} from './integration/feed-analysis-store.js';
import {
  parseFeedAnalysisWorkflowResult,
  prepareFeedAnalysisInput,
} from './integration/feed-analysis-workflow.js';
import {
  listFeedAnalysisDeadLetters,
  processDueFeedAnalysisCallbacks,
  replayFeedAnalysisDeadLetter,
} from './integration/feed-analysis-callback-outbox.js';
import type { FeedAnalysisResultEnvelope } from './integration/feed-analysis-types.js';

const LIMITS = {
  maxInlineBytes: 1024 * 1024,
  maxItems: 500,
  materialHosts: [],
  materialFetchTimeoutMs: 1000,
};

test('feed analysis workflow validates and normalizes structured output', async () => {
  const prepared = await prepareFeedAnalysisInput({
    sourceSystem: 'lot2extension',
    sourceJobId: 'workflow-fixture',
    deliveryMode: 'result_returning',
    requestedOutputs: ['daily_digest'],
    materialBundle: {
      schemaVersion: 'material-bundle-v1',
      bundleId: 'bundle-workflow-fixture',
      sourceSystem: 'lot2extension',
      items: [{ itemId: 'item-1', platform: 'x', titleOrCaption: 'A useful post' }],
      policy: { locale: 'zh-CN', citationRequired: true, allowExternalResearch: false },
    },
  }, LIMITS);

  const result = parseFeedAnalysisWorkflowResult(JSON.stringify({
    summary: '今日主要关注 AI 工具。',
    artifacts: [{ kind: 'daily_digest', body: '日报正文', citationRefs: ['src_1'] }],
    citations: [{ id: 'src_1', itemId: 'item-1' }],
    warnings: [],
  }), prepared, { provider: 'fixture', model: 'fixture-model', promptTokens: 10, completionTokens: 20 });

  assert.equal(result.schemaVersion, 'feed-analysis-result-v1');
  assert.equal(result.artifacts[0]?.kind, 'daily_digest');
  assert.equal(result.artifacts[0]?.workflowId, 'lot2.daily-content');
  assert.deepEqual(result.usage, { promptTokens: 10, completionTokens: 20, durationMs: undefined });
  assert.throws(
    () => parseFeedAnalysisWorkflowResult(JSON.stringify({ summary: 'missing artifact', artifacts: [] }), prepared),
    /missing requested output/,
  );
  await assert.rejects(
    prepareFeedAnalysisInput({
      sourceSystem: 'lot2extension', sourceJobId: 'remote-fixture', deliveryMode: 'result_returning',
      materialBundleRef: {
        bundleId: 'remote', inputDigest: '0'.repeat(64), url: 'https://untrusted.example.com/material.json',
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
    }, LIMITS),
    /not allowlisted/,
  );
});

test('feed analysis store enforces business idempotency and atomically persists results', async () => {
  await ensureFeedAnalysisStore();
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const dispatchId = `fa-store-${suffix}`;
  const input = {
    id: dispatchId,
    tenantId: 'tenant-test',
    projectId: 'project-test',
    sourceSystem: 'lot2extension',
    sourceJobId: `job-${suffix}`,
    deliveryMode: 'result_returning' as const,
    contractVersion: 'feed-analysis-v2',
    bundleVersion: 'material-bundle-v1',
    bundleId: `bundle-${suffix}`,
    inputDigest: `digest-${suffix}`,
    idempotencyKey: `idem-${suffix}`,
    requestedOutputs: ['daily_digest'],
    policy: { locale: 'zh-CN' },
    material: { schemaVersion: 'material-bundle-v1', items: [{ itemId: 'one', platform: 'x' }] },
  };
  try {
    const created = await createOrLoadFeedAnalysisDispatch(input);
    assert.equal(created.deduplicated, false);
    const replayed = await createOrLoadFeedAnalysisDispatch({ ...input, id: `${dispatchId}-replay` });
    assert.equal(replayed.deduplicated, true);
    assert.equal(replayed.record.id, dispatchId);

    await assert.rejects(
      createOrLoadFeedAnalysisDispatch({ ...input, id: `${dispatchId}-conflict`, inputDigest: 'different' }),
      (error: unknown) => error instanceof Error && error.message.includes('different input digest'),
    );

    const result = fixtureResult();
    await emitFeedAnalysisStatus(dispatchId, 'processing');
    const saved = await saveFeedAnalysisResult(dispatchId, result);
    assert.match(saved.resultDigest ?? '', /^[a-f0-9]{64}$/);
    const dispatch = await loadFeedAnalysisDispatch(dispatchId);
    assert.equal(dispatch?.status, 'completed');
    assert.equal(dispatch?.resultAvailable, true);
    const loaded = await loadFeedAnalysisResult(dispatchId);
    assert.equal(loaded?.summary, result.summary);
    const artifacts = await getDb().query<{ count: string }>(
      'SELECT count(*)::text AS count FROM feed_analysis_artifacts WHERE dispatch_id=$1', [dispatchId],
    );
    assert.equal(artifacts.rows[0]?.count, '1');
    await getDb().query(
      "UPDATE feed_analysis_dispatches SET retention_expires_at=now()-interval '1 minute' WHERE id=$1",
      [dispatchId],
    );
    assert.equal(await pruneExpiredFeedAnalysisMaterial(), 1);
    const material = await getDb().query<{ material_json: unknown }>(
      'SELECT material_json FROM feed_analysis_dispatches WHERE id=$1', [dispatchId],
    );
    assert.equal(material.rows[0]?.material_json, null);
  } finally {
    await getDb().query('DELETE FROM feed_analysis_dispatches WHERE id=$1', [dispatchId]);
  }
});

test('feed analysis callback dead letters can be listed and replayed', async () => {
  await ensureFeedAnalysisStore();
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const dispatchId = `fa-dead-letter-${suffix}`;
  try {
    await createOrLoadFeedAnalysisDispatch({
      id: dispatchId,
      tenantId: 'tenant-test',
      projectId: 'project-test',
      sourceSystem: 'lot2extension',
      sourceJobId: `job-${suffix}`,
      deliveryMode: 'result_returning',
      contractVersion: 'feed-analysis-v2',
      inputDigest: `digest-${suffix}`,
      idempotencyKey: `idem-${suffix}`,
      requestedOutputs: ['daily_digest'],
      policy: { locale: 'zh-CN' },
      callbackProfileId: `missing-${suffix}`,
    });
    const processed = await processDueFeedAnalysisCallbacks({}, { ownerId: `test-${suffix}` });
    assert.equal(processed.deadLettered, 1);
    const letters = await listFeedAnalysisDeadLetters(100);
    const delivery = letters.find(item => item.profileId === `missing-${suffix}`);
    assert.ok(delivery);
    assert.equal(await replayFeedAnalysisDeadLetter(delivery.id), true);
    assert.equal(await replayFeedAnalysisDeadLetter(delivery.id), false);
  } finally {
    await getDb().query('DELETE FROM feed_analysis_dispatches WHERE id=$1', [dispatchId]);
  }
});

test('feed analysis callback worker signs and delivers immutable event payloads', async () => {
  await ensureFeedAnalysisStore();
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const dispatchId = `fa-callback-${suffix}`;
  const secret = 'callback-secret-that-is-at-least-thirty-two-bytes';
  let receivedBody = '';
  let receivedTimestamp = '';
  let receivedSignature = '';
  const server = createServer((request, response) => {
    request.setEncoding('utf8');
    request.on('data', chunk => { receivedBody += chunk; });
    request.on('end', () => {
      receivedTimestamp = String(request.headers['x-los-timestamp'] ?? '');
      receivedSignature = String(request.headers['x-los-signature'] ?? '');
      response.writeHead(204).end();
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  try {
    await createOrLoadFeedAnalysisDispatch({
      id: dispatchId,
      tenantId: 'tenant-test',
      projectId: 'project-test',
      sourceSystem: 'lot2extension',
      sourceJobId: `job-${suffix}`,
      deliveryMode: 'result_returning',
      contractVersion: 'feed-analysis-v2',
      inputDigest: `digest-${suffix}`,
      idempotencyKey: `idem-${suffix}`,
      requestedOutputs: ['daily_digest'],
      policy: { locale: 'zh-CN' },
      callbackProfileId: 'fixture',
    });
    const delivery = await processDueFeedAnalysisCallbacks({
      fixture: { url: `http://127.0.0.1:${address.port}/events`, secret, timeoutMs: 2000, maxAttempts: 3 },
    }, { ownerId: `test-${suffix}` });
    assert.equal(delivery.delivered, 1);
    const expected = createHmac('sha256', secret).update(`${receivedTimestamp}.${receivedBody}`).digest('hex');
    assert.equal(receivedSignature, `v1=${expected}`);
    const payload = JSON.parse(receivedBody) as { dispatchId: string; status: string; sequence: number };
    assert.equal(payload.dispatchId, dispatchId);
    assert.equal(payload.status, 'accepted');
    assert.equal(payload.sequence, 1);
  } finally {
    server.close();
    await getDb().query('DELETE FROM feed_analysis_dispatches WHERE id=$1', [dispatchId]);
  }
});

function fixtureResult(): FeedAnalysisResultEnvelope {
  return {
    schemaVersion: 'feed-analysis-result-v1',
    summary: 'Fixture summary',
    artifacts: [{
      artifactId: 'fixture-artifact',
      kind: 'daily_digest',
      locale: 'zh-CN',
      titleCandidates: [],
      body: 'Fixture body',
      hashtags: [],
      structuredPayload: {},
      citationRefs: [],
      workflowId: 'lot2.daily-content',
      workflowVersion: '1.0.0',
      promptId: 'lot2.daily-content.generate',
      promptVersion: '1.0.0',
      reviewStatus: 'draft',
    }],
    citations: [],
    warnings: [],
    workflow: { id: 'lot2.daily-content', version: '1.0.0' },
    prompt: { id: 'lot2.daily-content.generate', version: '1.0.0' },
  };
}
