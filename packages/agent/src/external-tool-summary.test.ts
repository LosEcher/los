import test from 'node:test';
import assert from 'node:assert/strict';

import { loadConfig } from '@los/infra/config';
import { closeDb, getDb, initDb } from '@los/infra/db';
import {
  importExternalToolSummary,
  listExternalToolSummaries,
  normalizeExternalToolSummary,
} from './external-tool-summary.js';

const BASE_TIME = '2026-06-05T12:00:00.000Z';

test('external tool summary adapter redacts fake secrets and preserves provenance', () => {
  const summary = normalizeExternalToolSummary({
    tool: 'Codex',
    toolVersion: 'desktop-2026.06',
    source: {
      kind: 'operator_summary',
      sourceRef: 'operator-notes:agent-closeout',
      cwd: '/repo/projects/los',
      capturedAt: BASE_TIME,
    },
    provenance: {
      collectedAt: BASE_TIME,
      capturePolicy: 'bounded-summary-only',
      redactionPolicy: 'no raw prompt/stdout/stderr/auth snapshots',
      importedBy: 'test',
    },
    summary: 'Codex verified jj status. Fake key sk-test1234567890 must not survive.',
    findings: [
      'Reasonix captures are external receipt evidence only.',
      'Claude Code provider login is not compatibility proof.',
      'OMX Bearer abc.def.ghi token must not survive.',
    ],
    evidence: [
      { label: 'matrix', kind: 'file', value: 'docs/governance/toolchain-matrix.md' },
      { label: 'omx-policy', kind: 'file', value: 'docs/adr/0016-omx-tool-level-logging-scope.md' },
    ],
    metrics: {
      promptsReviewed: 6,
      rawTranscriptImported: false,
    },
    labels: ['codex', 'reasonix', 'claude-code', 'omx'],
  });

  assert.equal(summary.tool, 'codex');
  assert.equal(summary.evidenceClass, 'external_summary');
  assert.equal(summary.provenance.capturePolicy, 'bounded-summary-only');
  assert.equal(summary.redaction.status, 'redacted');
  assert.equal(summary.redaction.replacements, 2);
  assert.ok(!summary.summary.includes('sk-test1234567890'));
  assert.ok(!summary.findings.join('\n').includes('Bearer abc.def.ghi'));
  assert.deepEqual(summary.labels, ['codex', 'reasonix', 'claude-code', 'omx']);
});

test('external tool summary adapter rejects raw transcript-shaped fields', () => {
  assert.throws(
    () => normalizeExternalToolSummary({
      tool: 'reasonix',
      source: {
        kind: 'external_capture',
        sourceRef: '.reasonix/truncated-results/example.txt',
      },
      provenance: {
        collectedAt: BASE_TIME,
        capturePolicy: 'external-capture',
        redactionPolicy: 'not-redacted',
      },
      summary: 'This should be rejected before ingestion.',
      rawTranscript: 'full user prompt and tool output',
    } as never),
    /rejects raw field: input\.rawTranscript/,
  );

  assert.throws(
    () => normalizeExternalToolSummary({
      tool: 'omx',
      source: {
        kind: 'external_capture',
        sourceRef: '.omx/logs/omx-2026-06-05.jsonl',
      },
      provenance: {
        collectedAt: BASE_TIME,
        capturePolicy: 'external-capture',
        redactionPolicy: 'not-redacted',
      },
      summary: 'This should also be rejected.',
      evidence: [
        { label: 'raw stdout', kind: 'other', value: 'unsafe', stdout: 'command output' },
      ],
    } as never),
    /rejects raw field: input\.evidence\[0\]\.stdout/,
  );
});

// FIXME: This test creates its own DB pool via initDb which races with
// test-setup's ensureAllAgentStores. The store's _initialized flag prevents
// re-creation on the new pool. Skip until refactored. See PR #120.
test.skip('external tool summaries persist only redacted external_summary records', async () => {
  const config = await loadConfig();
  await initDb(config.databaseUrl);
  const id = `external-summary-test-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  try {
    const record = await importExternalToolSummary({
      id,
      tool: 'codex',
      toolVersion: 'desktop-2026.06',
      source: {
        kind: 'operator_summary',
        sourceRef: `operator-note:${id}`,
        cwd: '/repo/projects/los',
        capturedAt: BASE_TIME,
      },
      provenance: {
        collectedAt: BASE_TIME,
        capturePolicy: 'bounded-summary-only',
        redactionPolicy: 'no raw prompt/stdout/stderr/auth snapshots',
        importedBy: 'test',
      },
      summary: 'Codex inspected current status and saw fake key sk-test1234567890.',
      findings: ['External summary should not become session replay evidence.'],
      evidence: [
        { label: 'status', kind: 'command', value: 'jj status' },
      ],
      metrics: { commands: 3 },
      labels: ['codex', 'closeout'],
      retentionDays: 30,
    });

    assert.equal(record.id, id);
    assert.equal(record.evidenceClass, 'external_summary');
    assert.equal(record.redaction.status, 'redacted');
    assert.ok(!record.summary.includes('sk-test1234567890'));
    assert.ok(record.sourceHash.length >= 32);
    assert.ok(record.retentionExpiresAt);

    const listed = await listExternalToolSummaries({ tool: 'codex', limit: 10 });
    const loaded = listed.find(item => item.id === id);
    assert.equal(loaded?.evidenceClass, 'external_summary');
    assert.equal(loaded?.source.sourceRef, `operator-note:${id}`);
    assert.deepEqual(loaded?.labels, ['codex', 'closeout']);
  } finally {
    await getDb().query('DELETE FROM external_tool_summaries WHERE id = $1', [id]).catch(() => undefined);
  }
});
