import test from 'node:test';
import assert from 'node:assert/strict';

import { ensureSessionEventStore } from '@los/agent/session-events';
import { createRunSpec, ensureRunSpecStore, loadRunSpec } from '@los/agent/run-specs';
import { loadConfig } from '@los/infra/config';
import { closeDb, getDb, initDb } from '@los/infra/db';
import {
  applyChatResumeDispatchGuard,
  type ChatResumePlan,
} from './chat-resume-plan.js';

test.before(async () => {
  const config = await loadConfig();
  await initDb(config.databaseUrl);
  await ensureSessionEventStore();
  await ensureRunSpecStore();
});

test.after(async () => {
  await closeDb().catch(() => undefined);
});

test('suppresses duplicate resume dispatch through the run state machine', async () => {
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const sessionId = `session-resume-guard-${suffix}`;
  const currentRunSpecId = `run-resume-guard-${suffix}`;
  try {
    await createRunSpec({
      id: currentRunSpecId,
      sessionId,
      prompt: 'guard duplicate dispatch',
      workspaceRoot: process.cwd(),
      toolMode: 'read-only',
      allowedTools: [],
      toolRetry: {},
      maxLoops: 1,
      mcpServers: [],
      runContract: { phase: 'planning' },
    });
    const result = await applyChatResumeDispatchGuard({
      plan: resumePlan({ sessionActiveTaskRunIds: ['task-active'] }),
      planEventId: 42,
      currentRunSpecId,
      requestId: `request-${suffix}`,
      traceId: `trace-${suffix}`,
    });

    assert.equal(result.disposition, 'suppress');
    assert.equal(result.event?.type, 'run.resume_dispatch_suppressed');
    assert.equal(result.event?.payload.causationId, '42');
    const stored = await loadRunSpec(currentRunSpecId);
    assert.equal(stored?.status, 'blocked');
    assert.equal(stored?.runContract?.phase, 'blocked');
  } finally {
    const db = getDb();
    await db.query('DELETE FROM execution_outbox WHERE run_spec_id = $1', [currentRunSpecId]).catch(() => undefined);
    await db.query('DELETE FROM session_events WHERE session_id = $1', [sessionId]).catch(() => undefined);
    await db.query('DELETE FROM verification_records WHERE session_id = $1', [sessionId]).catch(() => undefined);
    await db.query('DELETE FROM run_specs WHERE session_id = $1', [sessionId]).catch(() => undefined);
  }
});

test('allows resume dispatch when no prior task is active', async () => {
  const result = await applyChatResumeDispatchGuard({
    plan: resumePlan(),
    planEventId: 42,
    currentRunSpecId: 'run-current',
    requestId: 'request-current',
    traceId: 'trace-current',
  });
  assert.deepEqual(result, { disposition: 'dispatch', reason: 'no_active_task', event: null });
});

function resumePlan(input: Partial<ChatResumePlan> = {}): ChatResumePlan {
  return {
    currentRunSpecId: 'run-current',
    selectedRunSpecId: 'run-previous',
    candidateRunSpecIds: ['run-previous'],
    selectionReason: 'latest_recoverable_run',
    phase: 'running',
    action: 'wait_for_task',
    blockerKinds: ['active_task'],
    activeTaskRunIds: [],
    sessionActiveTaskRunIds: [],
    failedTaskRunIds: [],
    failedVerificationRecordIds: [],
    pendingVerificationRecordIds: [],
    recoveryRecommendation: 'none',
    lastEventId: 1,
    ...input,
  };
}
