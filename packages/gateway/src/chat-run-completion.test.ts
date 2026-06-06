import test from 'node:test';
import assert from 'node:assert/strict';

import { loadConfig } from '@los/infra/config';
import { closeDb, getDb, initDb } from '@los/infra/db';
import { createRunSpec, listSessionEvents, loadRunSpec } from '@los/agent';
import { applyDirectRunCompletionStatus } from './chat-run-completion.js';

test('direct run completion uses execution store transitions for run spec status', async () => {
  const config = await loadConfig();
  await initDb(config.databaseUrl);

  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const runSpecId = `run-direct-completion-${suffix}`;
  const sessionId = `session-direct-completion-${suffix}`;
  const taskRunId = `task-direct-completion-${suffix}`;
  const requestId = `request-direct-completion-${suffix}`;
  const traceId = `trace-direct-completion-${suffix}`;

  try {
    await createRunSpec({
      id: runSpecId,
      sessionId,
      prompt: 'complete direct run',
      workspaceRoot: process.cwd(),
      toolMode: 'project-write',
      maxLoops: 1,
    });

    const decision = await applyDirectRunCompletionStatus({
      runSpecId,
      sessionId,
      taskRunId,
      requestId,
      traceId,
      nodeId: 'test-node',
    });

    assert.equal(decision.status, 'succeeded');
    assert.deepEqual(decision.blockedVerificationRecordIds, []);

    const runSpec = await loadRunSpec(runSpecId);
    assert.equal(runSpec?.status, 'succeeded');

    const events = await listSessionEvents(sessionId);
    const executionEvents = events.filter(event => event.source === 'los.execution');
    assert.equal(executionEvents.length, 2);
    assert.deepEqual(
      executionEvents.map(event => [event.type, event.payload.from, event.payload.to]),
      [
        ['run_spec.running', 'created', 'running'],
        ['run_spec.succeeded', 'running', 'succeeded'],
      ],
    );
    assert.equal(executionEvents[1]?.payload.commandId, requestId);
    assert.equal(executionEvents[1]?.payload.correlationId, traceId);

    const outbox = await getDb().query<{ count: string }>(
      'SELECT count(*)::text AS count FROM execution_outbox WHERE session_id = $1',
      [sessionId],
    );
    assert.equal(outbox.rows[0]?.count, '2');
  } finally {
    await getDb().query('DELETE FROM execution_outbox WHERE session_id = $1', [sessionId]).catch(() => undefined);
    await getDb().query('DELETE FROM session_events WHERE session_id = $1', [sessionId]).catch(() => undefined);
    await getDb().query('DELETE FROM verification_records WHERE run_spec_id = $1', [runSpecId]).catch(() => undefined);
    await getDb().query('DELETE FROM run_specs WHERE id = $1', [runSpecId]).catch(() => undefined);
    await closeDb().catch(() => undefined);
  }
});
