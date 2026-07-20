import test from 'node:test';
import assert from 'node:assert/strict';

import { loadSession } from '@los/agent/session';
import type { ScheduledAgentTaskResult } from '@los/agent/scheduler';
import { closeDb, getDb, initDb } from '@los/infra/db';
import { loadConfig } from '@los/infra/config';
import { handleNonCompletedOutcome } from './chat-service-outcomes.js';

test('awaiting approval persists the planning session and emits a distinct SSE outcome', async () => {
  const config = await loadConfig();
  await initDb(config.databaseUrl);
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const sessionId = `session-planning-outcome-${suffix}`;
  const runSpecId = `run-planning-outcome-${suffix}`;
  const taskRunId = `task-planning-outcome-${suffix}`;
  const events: Array<{ event: string; payload: unknown }> = [];
  const scheduled: Extract<ScheduledAgentTaskResult, { status: 'awaiting_approval' }> = {
    status: 'awaiting_approval',
    sessionId,
    planRevision: 1,
    planStepCount: 2,
    taskRun: {
      id: taskRunId,
      sessionId,
      runSpecId,
      traceId: `trace-${suffix}`,
      workspaceRoot: process.cwd(),
      toolMode: 'read-only',
      status: 'blocked',
      attempt: 1,
      promptPreview: 'Plan a bounded change',
      metadata: { disposition: 'planning', awaitingApproval: true },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      leaseVersion: 1,
    },
    result: {
      text: '{"summary":"Plan ready"}',
      messages: [{ role: 'assistant', content: 'Plan ready' }],
      turns: [],
      loopCount: 1,
      totalTokens: { prompt: 10, completion: 5 },
    },
  };

  try {
    const result = await handleNonCompletedOutcome({
      scheduled,
      prompt: 'Plan a bounded change',
      provider: undefined,
      model: undefined,
      workspaceRoot: process.cwd(),
      toolMode: 'project-write',
      boundTodoId: undefined,
      sid: sessionId,
      tenantId: 'default',
      projectId: 'los',
      userId: 'operator',
      requestId: `request-${suffix}`,
      traceId: scheduled.taskRun.traceId,
      runSpecId,
      config,
      send: (event, payload) => events.push({ event, payload }),
      identityName: undefined,
    });

    assert.equal(result.status, 'awaiting_approval');
    assert.deepEqual(events.map(event => event.event), ['awaiting_approval', 'done']);
    assert.equal((events[0]?.payload as Record<string, unknown>).planStepCount, 2);
    assert.equal((events[1]?.payload as Record<string, unknown>).awaitingApproval, true);
    const session = await loadSession(sessionId);
    assert.equal(session?.metadata.awaitingApproval, true);
    assert.equal(session?.metadata.toolMode, 'read-only');
    assert.equal(session?.metadata.runSpecId, runSpecId);
  } finally {
    await getDb().query('DELETE FROM sessions WHERE id = $1', [sessionId]).catch(() => undefined);
    await closeDb().catch(() => undefined);
  }
});
