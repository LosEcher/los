import test from 'node:test';
import assert from 'node:assert/strict';

import { loadConfig } from '@los/infra/config';
import { closeDb, getDb, initDb } from '@los/infra/db';
import {
  createAgentTask,
  createAgentTaskAttempt,
  linkAgentTaskDependency,
} from './agent-task-graph.js';
import { readRuntimeEvidenceGraph } from './runtime-evidence-graph.js';
import { createRunSpec } from './run-specs.js';
import { appendSessionEvent } from './session-events.js';
import { createTaskRun } from './task-runs.js';
import { createToolCallState } from './tool-call-states.js';
import { createVerificationRecord } from './verification-records.js';

test('runtime evidence graph projects run evidence across execution tables', async () => {
  const config = await loadConfig();
  await initDb(config.databaseUrl);

  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const runSpecId = `run-evidence-${suffix}`;
  const sessionId = `session-evidence-${suffix}`;
  const taskRunId = `task-evidence-${suffix}`;
  const graphId = `graph-evidence-${suffix}`;
  const toolCallStateId = `tool-evidence-${suffix}`;
  const verificationId = `verification-evidence-${suffix}`;
  const planTaskId = `${graphId}-plan`;
  const verifyTaskId = `${graphId}-verify`;
  const attemptId = `${verifyTaskId}-attempt-1`;

  try {
    await createRunSpec({
      id: runSpecId,
      sessionId,
      prompt: 'collect runtime evidence',
      workspaceRoot: process.cwd(),
      toolMode: 'project-write',
      maxLoops: 1,
    });
    await createTaskRun({
      id: taskRunId,
      sessionId,
      runSpecId,
      workspaceRoot: process.cwd(),
      toolMode: 'project-write',
      promptPreview: 'collect runtime evidence',
      status: 'succeeded',
    });
    const started = await appendSessionEvent({
      sessionId,
      type: 'task.created',
      payload: { runSpecId, taskRunId },
    });
    await appendSessionEvent({
      sessionId,
      type: 'tool.result',
      toolName: 'read_file',
      parentEventId: started.id,
      payload: { runSpecId, taskRunId, callId: toolCallStateId },
    });
    await createToolCallState({
      id: toolCallStateId,
      sessionId,
      runSpecId,
      taskRunId,
      turn: 1,
      toolName: 'read_file',
      state: 'succeeded',
      inputJson: { path: 'AGENTS.md' },
    });
    await createVerificationRecord({
      id: verificationId,
      sessionId,
      runSpecId,
      taskRunId,
      checkName: 'pnpm check',
      command: 'pnpm check',
      status: 'succeeded',
    });
    await createAgentTask({
      id: planTaskId,
      graphId,
      runSpecId,
      sessionId,
      role: 'planner',
      title: 'Plan evidence',
      status: 'succeeded',
      priority: 10,
    });
    await createAgentTask({
      id: verifyTaskId,
      graphId,
      runSpecId,
      sessionId,
      role: 'verifier',
      title: 'Verify evidence',
      status: 'succeeded',
      priority: 20,
    });
    await linkAgentTaskDependency({
      graphId,
      taskId: verifyTaskId,
      dependsOnTaskId: planTaskId,
    });
    await createAgentTaskAttempt({
      id: attemptId,
      graphId,
      taskId: verifyTaskId,
      status: 'succeeded',
      taskRunId,
      verificationRecordId: verificationId,
      toolCallStateIds: [toolCallStateId],
      outputSummary: 'evidence verified',
    });

    const graph = await readRuntimeEvidenceGraph(runSpecId);
    assert.ok(graph);
    assert.equal(graph.runSpecId, runSpecId);
    assert.equal(graph.sessionId, sessionId);
    assert.equal(graph.counts.run_spec, 1);
    assert.equal(graph.counts.task_run, 1);
    assert.equal(graph.counts.session_event, 2);
    assert.equal(graph.counts.tool_call_state, 1);
    assert.equal(graph.counts.verification_record, 1);
    assert.equal(graph.counts.agent_task, 2);
    assert.equal(graph.counts.task_attempt, 1);
    assert.deepEqual(graph.warnings, []);

    assertEdge(graph, `run_spec:${runSpecId}`, `task_run:${taskRunId}`, 'has_task_run');
    assertEdge(graph, `task_run:${taskRunId}`, `tool_call_state:${sessionId}:${toolCallStateId}`, 'has_tool_call_state');
    assertEdge(graph, `run_spec:${runSpecId}`, `verification_record:${verificationId}`, 'has_verification_record');
    assertEdge(graph, `agent_task:${planTaskId}`, `agent_task:${verifyTaskId}`, 'depends_on');
    assertEdge(graph, `agent_task:${verifyTaskId}`, `task_attempt:${attemptId}`, 'has_task_attempt');
    assertEdge(graph, `task_attempt:${attemptId}`, `task_run:${taskRunId}`, 'attempt_ran_as');
    assertEdge(graph, `task_attempt:${attemptId}`, `verification_record:${verificationId}`, 'attempt_verified_by');
    assertEdge(graph, `task_attempt:${attemptId}`, `tool_call_state:${sessionId}:${toolCallStateId}`, 'attempt_used_tool_state');

    assert.equal(await readRuntimeEvidenceGraph(`${runSpecId}-missing`), null);
  } finally {
    await getDb().query('DELETE FROM task_attempts WHERE graph_id = $1', [graphId]).catch(() => undefined);
    await getDb().query('DELETE FROM task_edges WHERE graph_id = $1', [graphId]).catch(() => undefined);
    await getDb().query('DELETE FROM agent_tasks WHERE graph_id = $1', [graphId]).catch(() => undefined);
    await getDb().query('DELETE FROM verification_records WHERE run_spec_id = $1', [runSpecId]).catch(() => undefined);
    await getDb().query('DELETE FROM tool_call_states WHERE session_id = $1', [sessionId]).catch(() => undefined);
    await getDb().query('DELETE FROM session_events WHERE session_id = $1', [sessionId]).catch(() => undefined);
    await getDb().query('DELETE FROM task_runs WHERE run_spec_id = $1', [runSpecId]).catch(() => undefined);
    await getDb().query('DELETE FROM run_specs WHERE id = $1', [runSpecId]).catch(() => undefined);
    await closeDb().catch(() => undefined);
  }
});

function assertEdge(
  graph: NonNullable<Awaited<ReturnType<typeof readRuntimeEvidenceGraph>>>,
  from: string,
  to: string,
  kind: string,
): void {
  assert.ok(
    graph.edges.some(edge => edge.from === from && edge.to === to && edge.kind === kind),
    `missing edge ${from} -[${kind}]-> ${to}`,
  );
}
