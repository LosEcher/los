/**
 * claimBlockedTaskRunsWithAnswer tests — verifies the blocked-task resume claim:
 * only blocked task_runs with an answered, unconsumed `ask` are claimed, and
 * claiming marks the ask consumed so a second tick cannot double-resume.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { closeDb, getDb, initDb } from '@los/infra/db';
import { loadConfig } from '@los/infra/config';
import { ensureAllAgentStores } from '../ensure-all-stores.js';
import { createTaskRun, ensureTaskRunStore } from '../task-runs.js';
import { claimBlockedTaskRunsWithAnswer } from './blocked-resume.js';
import { sendWorkerMessage, recordWorkerAnswer } from '../worker-messages.js';

test('claimBlockedTaskRunsWithAnswer claims a blocked task with an answered ask', async () => {
  const config = await loadConfig();
  await initDb(config.databaseUrl);
  try {
    await ensureAllAgentStores();
    await ensureTaskRunStore();

    const taskRunId = `task-${randomUUID()}`;
    const dispatchId = `${taskRunId}-attempt-1-${randomUUID()}`;
    const graphId = `graph-${randomUUID()}`;
    const taskId = `agenttask-${randomUUID()}`;

    // blocked task_run
    await createTaskRun({
      id: taskRunId,
      sessionId: 'sess-claim',
      traceId: `trace-${taskRunId}`,
      workspaceRoot: '/tmp',
      toolMode: 'project-write',
      promptPreview: 'do work',
      metadata: {},
    });
    await getDb().query(
      `UPDATE task_runs SET status = 'blocked' WHERE id = $1`,
      [taskRunId],
    );

    // task_attempt linking the task_run to the dispatch id
    await getDb().query(
      `INSERT INTO task_attempts (id, graph_id, task_id, attempt, status, task_run_id, provider, model)
       VALUES ($1, $2, $3, 1, 'failed', $4, 'p', 'm')`,
      [dispatchId, graphId, taskId, taskRunId],
    );

    // ask message with no answer yet
    const ask = await sendWorkerMessage({
      dispatchId,
      taskId,
      type: 'ask',
      payload: { question: 'which branch?' },
    });

    // no answer yet → not claimed
    let claimed = await claimBlockedTaskRunsWithAnswer(10);
    assert.equal(claimed.find(c => c.taskRun.id === taskRunId), undefined,
      'should not claim before answer');

    // answer it
    await recordWorkerAnswer(ask.id, 'feat/foo');

    // now claimed
    claimed = await claimBlockedTaskRunsWithAnswer(10);
    const hit = claimed.find(c => c.taskRun.id === taskRunId);
    assert.ok(hit, 'should claim after answer');
    assert.equal(hit!.answer, 'feat/foo');
    assert.equal(hit!.question, 'which branch?');
    assert.equal(hit!.dispatchId, dispatchId);
    assert.equal(hit!.agentTaskId, taskId);
    assert.equal(hit!.graphId, graphId);

    // second tick does not double-resume (consumed_at set)
    const claimedAgain = await claimBlockedTaskRunsWithAnswer(10);
    assert.equal(claimedAgain.find(c => c.taskRun.id === taskRunId), undefined,
      'should not claim a second time');
  } finally {
    await closeDb();
  }
});

test('claimBlockedTaskRunsWithAnswer ignores tasks that are not blocked', async () => {
  const config = await loadConfig();
  await initDb(config.databaseUrl);
  try {
    await ensureAllAgentStores();
    const taskRunId = `task-${randomUUID()}`;
    const dispatchId = `${taskRunId}-attempt-1-${randomUUID()}`;
    await createTaskRun({
      id: taskRunId,
      sessionId: 'sess-running',
      traceId: `trace-${taskRunId}`,
      workspaceRoot: '/tmp',
      toolMode: 'project-write',
      promptPreview: 'do work',
      metadata: {},
    });
    // leave status = 'running' (createTaskRun default)
    await getDb().query(
      `INSERT INTO task_attempts (id, graph_id, task_id, attempt, status, task_run_id)
       VALUES ($1, 'g', 't', 1, 'running', $2)`,
      [dispatchId, taskRunId],
    );
    const ask = await sendWorkerMessage({
      dispatchId,
      type: 'ask',
      payload: { question: 'go?' },
    });
    await recordWorkerAnswer(ask.id, 'yes');

    const claimed = await claimBlockedTaskRunsWithAnswer(10);
    assert.equal(claimed.find(c => c.taskRun.id === taskRunId), undefined,
      'running task must not be claimed even with an answered ask');
  } finally {
    await closeDb();
  }
});
