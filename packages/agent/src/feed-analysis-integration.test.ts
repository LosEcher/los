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
import { emitFeedAnalysisProgress } from './integration/feed-analysis-progress.js';
import {
  buildFeedAnalysisWorkflowPrompt,
  parseFeedAnalysisWorkflowResult,
  prepareFeedAnalysisInput,
} from './integration/feed-analysis-workflow.js';
import { runFeedAnalysisResearchGraph } from './integration/feed-analysis-research-graph.js';
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
  const normalized = parseFeedAnalysisWorkflowResult(JSON.stringify({
    summary: { keyTheme: '结构化 Agent 内容工作流' },
    artifacts: [{ kind: 'daily_digest', body: '日报正文', citationRefs: ['item-1'] }],
    citations: [{ id: 'src_1', itemId: 'item-1' }],
    warnings: [],
  }), prepared);
  assert.equal(normalized.summary, '结构化 Agent 内容工作流');
  assert.deepEqual(normalized.artifacts[0]?.citationRefs, ['src_1']);
  const filtered = parseFeedAnalysisWorkflowResult(JSON.stringify({
    summary: '保留请求的产物。',
    artifacts: [
      { kind: 'daily_digest', body: '日报正文', citationRefs: ['src_1'] },
      { kind: 'insight', body: '模型额外扩展', citationRefs: ['src_1'] },
    ],
    citations: [{ id: 'src_1', itemId: 'item-1' }],
    warnings: [{ message: '输入证据有限' }],
  }), prepared);
  assert.equal(filtered.artifacts.length, 1);
  assert.deepEqual(filtered.warnings, [
    '输入证据有限',
    'Ignored unsupported artifact kind at index 1: insight',
  ]);
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

test('feed analysis routes explicit S2 and S3 snapshots to compatible workflows', async () => {
  const batch = await prepareFeedAnalysisInput({
    sourceSystem: 'lot2extension',
    sourceJobId: 'batch-fixture',
    deliveryMode: 'result_returning',
    scenario: 'evidence_batch',
    collectionSnapshot: { snapshotId: 'snap-batch', observationCount: 2 },
    requestedOutputs: ['content_brief'],
    materialBundle: {
      schemaVersion: 'material-bundle-v1',
      bundleId: 'snap-batch',
      sourceSystem: 'lot2extension',
      items: [
        { itemId: 'x-1', platform: 'x', titleOrCaption: 'First view' },
        { itemId: 'zhihu-1', platform: 'zhihu', titleOrCaption: 'Related context' },
      ],
    },
  }, LIMITS);
  assert.equal(batch.workflow.profile, 'batch_summary');
  assert.equal(batch.workflow.workflowId, 'lot2.batch-summary');
  assert.equal(batch.workflow.maxLoops, 1);
  const batchPrompt = buildFeedAnalysisWorkflowPrompt(batch);
  assert.match(batchPrompt, /locked evidence batch/);
  assert.match(batchPrompt, /Allowed artifact kind values are exactly/);
  assert.match(batchPrompt, /Do not add insight, matrix, analysis/);

  const research = await prepareFeedAnalysisInput({
    sourceSystem: 'lot2extension',
    sourceJobId: 'research-fixture',
    deliveryMode: 'result_returning',
    scenario: 'research_topic',
    collectionSnapshot: { snapshotId: 'snap-research', observationCount: 1 },
    topic: {
      topicId: 'topic-ai-ops',
      title: 'AI 内容运营',
      brief: '验证跨平台证据和写作建议',
      targetPlatforms: ['x', 'zhihu', 'xiaohongshu'],
    },
    workflowHint: { profile: 'research_deep', maxLoops: 4 },
    requestedOutputs: ['daily_digest', 'content_brief', 'platform_draft'],
    materialBundle: {
      schemaVersion: 'material-bundle-v1',
      bundleId: 'snap-research',
      sourceSystem: 'lot2extension',
      items: [{ itemId: 'x-2', platform: 'x', titleOrCaption: 'Research source' }],
      policy: { allowExternalResearch: true },
    },
  }, LIMITS);
  assert.equal(research.workflow.profile, 'research_deep');
  assert.equal(research.workflow.workflowId, 'lot2.research-topic');
  assert.equal(research.workflow.maxLoops, 4);
  const researchPrompt = buildFeedAnalysisWorkflowPrompt(research);
  assert.match(researchPrompt, /research plan, evidence analysis, synthesis, platform adaptation, and final verification/);
  assert.match(researchPrompt, /AI 内容运营/);
  assert.match(researchPrompt, /one separate artifact for each target platform: x, zhihu, xiaohongshu/);
  assert.match(researchPrompt, /"platform":"x"/);

  await assert.rejects(
    prepareFeedAnalysisInput({
      sourceSystem: 'lot2extension', sourceJobId: 'bad-count', deliveryMode: 'result_returning',
      scenario: 'evidence_batch', collectionSnapshot: { snapshotId: 'snap-bad', observationCount: 2 },
      materialBundle: {
        schemaVersion: 'material-bundle-v1', bundleId: 'snap-bad', sourceSystem: 'lot2extension',
        items: [{ itemId: 'one', platform: 'x' }],
      },
    }, LIMITS),
    /observationCount does not match/,
  );
  await assert.rejects(
    prepareFeedAnalysisInput({
      sourceSystem: 'lot2extension', sourceJobId: 'missing-topic', deliveryMode: 'result_returning',
      scenario: 'research_topic', collectionSnapshot: { snapshotId: 'snap-topic', observationCount: 1 },
      materialBundle: {
        schemaVersion: 'material-bundle-v1', bundleId: 'snap-topic', sourceSystem: 'lot2extension',
        items: [{ itemId: 'one', platform: 'x' }],
      },
    }, LIMITS),
    /requires topicId and title/,
  );
});

test('research_deep executes a serial graph and passes bounded stage output forward', async () => {
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const dispatchId = `fa-research-graph-${suffix}`;
  const sessionId = `session-research-graph-${suffix}`;
  const graphId = `feed-analysis-research:${dispatchId}`;
  const prompts: string[] = [];
  const allowedToolSets: unknown[] = [];
  const server = createServer((request, response) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      const requestBody = JSON.parse(body) as { prompt?: unknown; config?: { allowedTools?: unknown } };
      const prompt = String(requestBody.prompt ?? '');
      prompts.push(prompt);
      allowedToolSets.push(requestBody.config?.allowedTools);
      const text = prompts.length === 5
        ? JSON.stringify({
            summary: '专题研究完成',
            artifacts: [
              { kind: 'daily_digest', body: '日报', citationRefs: ['src_1'] },
              { kind: 'content_brief', body: '简报', citationRefs: ['src_1'] },
              { kind: 'platform_draft', platform: 'x', body: 'X 草稿', citationRefs: ['src_1'] },
            ],
            citations: [{ id: 'src_1', itemId: 'source-1' }],
            warnings: [],
          })
        : `stage-${prompts.length}-output`;
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({
        events: [], deltas: [],
        result: {
          text,
          turns: [],
          loopCount: 1,
          totalTokens: { prompt: 10, completion: 5 },
          messages: [],
        },
      }));
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  try {
    const prepared = await prepareFeedAnalysisInput({
      sourceSystem: 'lot2extension',
      sourceJobId: `research-job-${suffix}`,
      deliveryMode: 'result_returning',
      scenario: 'research_topic',
      collectionSnapshot: { snapshotId: `snapshot-${suffix}`, observationCount: 1 },
      topic: { topicId: `topic-${suffix}`, title: 'Agent 内容运营' },
      workflowHint: { profile: 'research_deep', maxLoops: 1 },
      requestedOutputs: ['daily_digest', 'content_brief', 'platform_draft'],
      materialBundle: {
        schemaVersion: 'material-bundle-v1',
        bundleId: `snapshot-${suffix}`,
        sourceSystem: 'lot2extension',
        items: [{ itemId: 'source-1', platform: 'x', titleOrCaption: 'Source evidence' }],
      },
    }, LIMITS);
    const result = await runFeedAnalysisResearchGraph({
      dispatchId,
      runSpecId: dispatchId,
      sessionId,
      traceId: `trace-${suffix}`,
      workspaceRoot: process.cwd(),
      tenantId: 'tenant-test',
      projectId: 'project-test',
      prepared,
      executor: {
        enabled: true,
        nodeUrls: [`http://127.0.0.1:${address.port}`],
        nodeId: `research-executor-${suffix}`,
      },
    });
    assert.equal(prompts.length, 5);
    assert.match(prompts[1] ?? '', /stage-1-output/);
    assert.match(prompts[4] ?? '', /stage-4-output/);
    assert.match(prompts[0] ?? '', /Workspace and external tools are disabled/);
    assert.deepEqual(allowedToolSets, [[], [], [], [], []]);
    assert.equal(result.promptTokens, 50);
    assert.equal(result.completionTokens, 25);
    const parsed = parseFeedAnalysisWorkflowResult(result.text, prepared);
    assert.equal(parsed.workflow.id, 'lot2.research-topic');
    assert.equal(parsed.artifacts.length, 3);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    await getDb().query('DELETE FROM scheduler_decisions WHERE graph_id=$1', [graphId]).catch(() => undefined);
    await getDb().query('DELETE FROM task_attempts WHERE graph_id=$1', [graphId]).catch(() => undefined);
    await getDb().query('DELETE FROM task_edges WHERE graph_id=$1', [graphId]).catch(() => undefined);
    await getDb().query('DELETE FROM agent_tasks WHERE graph_id=$1', [graphId]).catch(() => undefined);
    await getDb().query('DELETE FROM tool_call_states WHERE session_id=$1', [sessionId]).catch(() => undefined);
    await getDb().query('DELETE FROM session_events WHERE session_id=$1', [sessionId]).catch(() => undefined);
    await getDb().query('DELETE FROM task_runs WHERE session_id=$1', [sessionId]).catch(() => undefined);
  }
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
    callbackProfileId: 'fixture-progress',
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
    await emitFeedAnalysisProgress(dispatchId, { stage: 'analyst', title: 'Analyze locked evidence' });
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
    const callbackEvents = await getDb().query<{ status: string; payload_json: { progress?: { stage?: string } } }>(
      'SELECT status, payload_json FROM feed_analysis_callback_events WHERE dispatch_id=$1 ORDER BY sequence', [dispatchId],
    );
    assert.deepEqual(callbackEvents.rows.map(event => event.status), ['accepted', 'processing', 'progress', 'completed']);
    assert.equal(callbackEvents.rows[2]?.payload_json.progress?.stage, 'analyst');
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
