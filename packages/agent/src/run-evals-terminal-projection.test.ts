import test from 'node:test';
import assert from 'node:assert/strict';

import { loadConfig } from '@los/infra/config';
import { closeDb, getDb, initDb } from '@los/infra/db';
import { createRunSpec } from './run-specs.js';
import { ensureSessionEventStore, appendSessionEvent } from './session-events.js';
import { ensureRunEvalStore, listRunEvals, recordRunEval, summarizeRunEvals } from './run-evals.js';
import { scheduleTerminalRunEval } from './run-evals/terminal-projection.js';

async function waitForTerminalEval(runSpecId: string, attempts = 40): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    const listed = await listRunEvals({ runSpecId, limit: 10 });
    if (listed.some(row => String(row.id).startsWith('run-eval-terminal-'))) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`terminal eval not projected for ${runSpecId}`);
}

test('scheduleTerminalRunEval upserts a fleet single eval from run evidence', async () => {
  const config = await loadConfig();
  await initDb(config.databaseUrl);
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const runSpecId = `run-terminal-eval-${suffix}`;
  const sessionId = `session-terminal-eval-${suffix}`;

  try {
    await createRunSpec({
      id: runSpecId,
      sessionId,
      prompt: 'terminal projection fixture',
      workspaceRoot: '/tmp/workspace',
      toolMode: 'read-only',
      provider: 'deepseek',
      model: 'deepseek-v4-flash',
    });
    await ensureSessionEventStore();
    await appendSessionEvent({
      sessionId,
      type: 'session.started',
      source: 'test',
      payload: { promptPreview: 'terminal projection fixture' },
    });
    await appendSessionEvent({
      sessionId,
      type: 'tool.result',
      source: 'test',
      payload: { ok: false, durationMs: 12 },
    });
    await appendSessionEvent({
      sessionId,
      type: 'session.completed',
      source: 'test',
      payload: {},
    });
    await ensureRunEvalStore();

    scheduleTerminalRunEval({
      runSpecId,
      sessionId,
      status: 'succeeded',
    });
    await waitForTerminalEval(runSpecId);

    const listed = await listRunEvals({ runSpecId, limit: 10 });
    const first = listed.find(row => String(row.id).startsWith('run-eval-terminal-'));
    assert.ok(first);
    assert.equal(first!.success, true);
    assert.equal(first!.provider, 'deepseek');
    assert.equal(first!.model, 'deepseek-v4-flash');
    assert.equal(first!.toolErrorCount, 1);
    assert.equal(first!.summary.kind, 'terminal_projection');
    assert.equal(first!.summary.terminalStatus, 'succeeded');

    // Second schedule overwrites same stable id (idempotent projection).
    scheduleTerminalRunEval({
      runSpecId,
      sessionId,
      status: 'blocked',
      reason: 'required verification records are not satisfied',
    });
    await new Promise(resolve => setTimeout(resolve, 80));
    const after = await listRunEvals({ runSpecId, limit: 10 });
    const second = after.find(row => String(row.id).startsWith('run-eval-terminal-'));
    assert.ok(second);
    assert.equal(second!.id, first!.id);
    assert.equal(second!.success, false);
    assert.equal(second!.failureClass, 'verification_failed');
    assert.equal(after.filter(row => String(row.id).startsWith('run-eval-terminal-')).length, 1);
  } finally {
    await getDb().query('DELETE FROM run_evals WHERE run_spec_id = $1', [runSpecId]).catch(() => undefined);
    await getDb().query('DELETE FROM session_events WHERE session_id = $1', [sessionId]).catch(() => undefined);
    await getDb().query('DELETE FROM run_specs WHERE id = $1', [runSpecId]).catch(() => undefined);
    await closeDb().catch(() => undefined);
  }
});

test('listRunEvals excludes backlog noise by default', async () => {
  const config = await loadConfig();
  await initDb(config.databaseUrl);
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const realRunId = `run-fleet-real-${suffix}`;
  const realId = `eval-real-${suffix}`;
  const noiseId = `eval-noise-${suffix}`;

  try {
    await ensureRunEvalStore();
    await recordRunEval({
      id: realId,
      runSpecId: realRunId,
      provider: 'deepseek',
      model: 'deepseek-v4-flash',
      success: true,
      latencyMs: 10,
      summary: { kind: 'fixture', metricSource: 'test' },
    });
    await recordRunEval({
      id: noiseId,
      runSpecId: 'eval-backlog',
      provider: 'backlog',
      model: 'n/a',
      success: false,
      summary: { kind: 'eval_backlog_snapshot', metricSource: 'document' },
    });

    const quiet = await listRunEvals({ limit: 500 });
    assert.ok(quiet.some(row => row.id === realId), 'real eval visible by default');
    assert.ok(!quiet.some(row => row.id === noiseId), 'backlog noise hidden by default');

    const noisy = await listRunEvals({ limit: 500, includeNoise: true });
    assert.ok(noisy.some(row => row.id === noiseId), 'noise visible when includeNoise=true');
  } finally {
    await getDb().query('DELETE FROM run_evals WHERE id = ANY($1::text[])', [
      [realId, noiseId],
    ]).catch(() => undefined);
    await closeDb().catch(() => undefined);
  }
});
