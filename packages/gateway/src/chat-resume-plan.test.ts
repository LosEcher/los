import test from 'node:test';
import assert from 'node:assert/strict';

import { ensureSessionEventStore } from '@los/agent/session-events';
import { createRunSpec, ensureRunSpecStore } from '@los/agent/run-specs';
import { loadConfig } from '@los/infra/config';
import { closeDb, getDb, initDb } from '@los/infra/db';
import { prepareChatResumePlan } from './chat-resume-plan.js';

test.before(async () => {
  const config = await loadConfig();
  await initDb(config.databaseUrl);
  await ensureSessionEventStore();
  await ensureRunSpecStore();
});

test.after(async () => {
  await closeDb().catch(() => undefined);
});

test('persists a bounded resume plan from prior run state', async () => {
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const sessionId = `session-resume-plan-${suffix}`;
  const previousRunSpecId = `run-resume-previous-${suffix}`;
  const currentRunSpecId = `run-resume-current-${suffix}`;
  const promptMarker = `private-resume-prompt-${suffix}`;

  try {
    await createTestRunSpec(previousRunSpecId, sessionId, promptMarker);
    await createTestRunSpec(currentRunSpecId, sessionId, 'current request');

    const prepared = await prepareChatResumePlan({
      sessionId,
      currentRunSpecId,
      tenantId: `tenant-${suffix}`,
      projectId: `project-${suffix}`,
      userId: `user-${suffix}`,
      requestId: `request-${suffix}`,
      traceId: `trace-${suffix}`,
    });

    assert.equal(prepared.plan.selectedRunSpecId, previousRunSpecId);
    assert.deepEqual(prepared.plan.candidateRunSpecIds, [previousRunSpecId]);
    assert.equal(prepared.plan.selectionReason, 'latest_recoverable_run');
    assert.equal(prepared.plan.phase, 'created');
    assert.equal(prepared.plan.action, 'wait_for_task');
    assert.equal(prepared.event.type, 'coordinator.resume_plan_selected');
    assert.equal(prepared.event.visibility, 'audit');
    assert.equal(prepared.event.payload.currentRunSpecId, currentRunSpecId);
    assert.ok(prepared.plan.lastEventId === null || prepared.plan.lastEventId < prepared.event.id);
    assert.equal(JSON.stringify(prepared.event.payload).includes(promptMarker), false);
  } finally {
    const db = getDb();
    await db.query('DELETE FROM session_events WHERE session_id = $1', [sessionId]).catch(() => undefined);
    await db.query('DELETE FROM verification_records WHERE session_id = $1', [sessionId]).catch(() => undefined);
    await db.query('DELETE FROM tool_call_states WHERE session_id = $1', [sessionId]).catch(() => undefined);
    await db.query('DELETE FROM task_runs WHERE session_id = $1', [sessionId]).catch(() => undefined);
    await db.query('DELETE FROM run_specs WHERE session_id = $1', [sessionId]).catch(() => undefined);
  }
});

async function createTestRunSpec(id: string, sessionId: string, prompt: string): Promise<void> {
  await createRunSpec({
    id,
    sessionId,
    prompt,
    workspaceRoot: process.cwd(),
    toolMode: 'read-only',
    allowedTools: [],
    toolRetry: {},
    maxLoops: 1,
    mcpServers: [],
  });
}
