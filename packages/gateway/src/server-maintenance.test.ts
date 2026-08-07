import test from 'node:test';
import assert from 'node:assert/strict';

import { loadConfig } from '@los/infra/config';
import { closeDb, getDb, initDb } from '@los/infra/db';
import {
  claimReadyAgentTasks,
  createAgentTask,
  createAgentTaskAttempt,
  listAgentTasksForGraph,
} from '@los/agent/agent-task-graph';
import { createTaskRun, loadTaskRun } from '@los/agent/task-runs';
import { transitionExecutionState } from '@los/agent/execution-store';
import { listSessionEvents } from '@los/agent/session-events';
import { ensureMemoryStore } from '@los/memory';
import { reapExpiredExecutionLeases, selectAutoCompactCandidates } from './server-maintenance.js';

test('periodic lease reaper fails exhausted graph work and records durable evidence', async () => {
  const config = await loadConfig();
  await initDb(config.databaseUrl);
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const graphId = `graph-reaper-${suffix}`;
  const agentTaskId = `${graphId}-task`;
  const taskRunId = `task-reaper-${suffix}`;
  const sessionId = `session-reaper-${suffix}`;
  try {
    await createAgentTask({
      id: agentTaskId,
      graphId,
      sessionId,
      role: 'executor',
      title: 'Expire this task',
      maxAttempts: 1,
    });
    const [claimed] = await claimReadyAgentTasks({ graphId, nodeId: 'node-reaper', leaseMs: 30_000 });
    assert.ok(claimed);
    await createTaskRun({
      id: taskRunId,
      sessionId,
      nodeId: 'node-reaper',
      workspaceRoot: process.cwd(),
      toolMode: 'project-write',
      promptPreview: 'expire this run',
      leaseVersion: claimed.leaseVersion,
      leaseExpiresAt: new Date(Date.now() + 30_000),
    });
    await transitionExecutionState({
      entityType: 'task_run',
      entityId: taskRunId,
      to: 'running',
      reason: 'reaper_test_start',
      nodeId: 'node-reaper',
      leaseVersion: claimed.leaseVersion,
    });
    await createAgentTaskAttempt({
      id: `${agentTaskId}-attempt-1`,
      graphId,
      taskId: agentTaskId,
      attempt: 1,
      status: 'running',
      nodeId: 'node-reaper',
      taskRunId,
    });
    await getDb().query(
      'UPDATE task_runs SET lease_expires_at = now() - interval \'1 second\' WHERE id = $1',
      [taskRunId],
    );
    await getDb().query(
      'UPDATE agent_tasks SET lease_expires_at = now() - interval \'1 second\' WHERE id = $1',
      [agentTaskId],
    );

    const result = await reapExpiredExecutionLeases('test_periodic_reaper');
    assert.deepEqual(result, { taskRuns: 1, agentTasks: 1, exhaustedAgentTasks: 1 });
    assert.equal((await loadTaskRun(taskRunId))?.status, 'failed');
    assert.equal((await listAgentTasksForGraph(graphId)).find(task => task.id === agentTaskId)?.status, 'failed');
    assert.equal(
      (await listSessionEvents(sessionId, 100)).some(event => event.type === 'agent_task.failed'),
      true,
    );
    const deadLetters = await getDb().query<{ reason: string }>(
      'SELECT reason FROM dead_letter_events WHERE task_run_id = $1 ORDER BY created_at',
      [taskRunId],
    );
    assert.deepEqual(deadLetters.rows.map(row => row.reason).sort(), ['lease_expired', 'max_attempts']);
  } finally {
    await getDb().query('DELETE FROM dead_letter_events WHERE task_run_id = $1', [taskRunId]).catch(() => undefined);
    await getDb().query('DELETE FROM execution_outbox WHERE entity_id = $1', [taskRunId]).catch(() => undefined);
    await getDb().query(
      "DELETE FROM session_events WHERE session_id = $1 OR (source = 'dead_letter' AND payload_json->>'taskRunId' = $2)",
      [sessionId, taskRunId],
    ).catch(() => undefined);
    await getDb().query('DELETE FROM task_attempts WHERE graph_id = $1', [graphId]).catch(() => undefined);
    await getDb().query('DELETE FROM task_runs WHERE id = $1', [taskRunId]).catch(() => undefined);
    await getDb().query('DELETE FROM agent_tasks WHERE graph_id = $1', [graphId]).catch(() => undefined);
    await closeDb().catch(() => undefined);
  }
});

test('selectAutoCompactCandidates: only sessions with observations accumulated since last compaction', async () => {
  const config = await loadConfig();
  await initDb(config.databaseUrl);
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const freshSession = `ac-fresh-${suffix}`;
  const compactedSession = `ac-compacted-${suffix}`;
  const archivedSession = `ac-archived-${suffix}`;
  try {
    await ensureMemoryStore();
    const insert = (sessionId: string, title: string, metadata: Record<string, unknown>) =>
      getDb().query(
        `INSERT INTO observations (session_id, title, kind, metadata_json, created_at)
         VALUES ($1, $2, 'note', $3::jsonb, now() - interval '100 hours')`,
        [sessionId, title, JSON.stringify(metadata)],
      );
    // 12 new (non-compacted) observations — must appear as candidate
    for (let i = 0; i < 12; i++) {
      await insert(freshSession, `f-${i}`, { referenceCount: 0, toolStatus: 'failed' });
    }
    // 12 observations already processed by a compaction — must be excluded
    for (let i = 0; i < 12; i++) {
      await insert(compactedSession, `c-${i}`, { referenceCount: 0, toolStatus: 'failed', compacted: true });
    }
    // Archived observations — must be excluded
    await insert(archivedSession, 'a-0', { archived: true });

    const candidates = await selectAutoCompactCandidates(getDb());
    const sessions = candidates.map(c => c.sessionId);
    assert.ok(sessions.includes(freshSession), 'session with new observations must be a candidate');
    assert.equal(sessions.includes(compactedSession), false, 'fully compacted session must not be a candidate');
    assert.equal(sessions.includes(archivedSession), false, 'archived-only session must not be a candidate');
    const fresh = candidates.find(c => c.sessionId === freshSession);
    assert.equal(fresh?.obsCount, '12');
  } finally {
    await getDb().query(
      "DELETE FROM observations WHERE session_id = ANY($1::text[])",
      [[freshSession, compactedSession, archivedSession]],
    ).catch(() => undefined);
    await closeDb().catch(() => undefined);
  }
});

// ── Compaction failure compensation (P0-3) ──────────────

test('compaction backoff: failure counting, exponential backoff and clearing', async () => {
  const { _recordCompactionFailure, _compactionBackoffElapsed, _clearCompactionFailure, _resetCompactionBackoff } =
    await import('./server-maintenance.js');
  _resetCompactionBackoff();
  const sessionId = `backoff-test-${Date.now()}`;
  try {
    // Never failed → no backoff.
    assert.equal(_compactionBackoffElapsed(sessionId), true);

    // First failure: 1h backoff.
    const t0 = 1_000_000;
    assert.equal(_recordCompactionFailure(sessionId, t0), 1);
    assert.equal(_compactionBackoffElapsed(sessionId, t0 + 30 * 60_000), false);
    assert.equal(_compactionBackoffElapsed(sessionId, t0 + 60 * 60_000), true);

    // Second failure: 2h backoff (exponential).
    assert.equal(_recordCompactionFailure(sessionId, t0 + 60 * 60_000), 2);
    assert.equal(_compactionBackoffElapsed(sessionId, t0 + 60 * 60_000 + 90 * 60_000), false);
    assert.equal(_compactionBackoffElapsed(sessionId, t0 + 60 * 60_000 + 2 * 3600_000), true);

    // Third failure: 4h backoff.
    assert.equal(_recordCompactionFailure(sessionId, t0 + 3 * 3600_000), 3);
    assert.equal(_compactionBackoffElapsed(sessionId, t0 + 3 * 3600_000 + 3 * 3600_000), false);

    // Success clears the state.
    _clearCompactionFailure(sessionId);
    assert.equal(_compactionBackoffElapsed(sessionId), true);
    assert.equal(_recordCompactionFailure(sessionId, t0 + 10 * 3600_000), 1, 'count resets after clear');
  } finally {
    _resetCompactionBackoff();
  }
});
