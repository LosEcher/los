import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeExternalToolSummary } from './external-tool-summary.js';

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
