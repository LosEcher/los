/**
 * @los/agent/task-runs/blocked-resume — claim blocked task_runs whose `ask` has been answered.
 *
 * Extracted from task-runs.ts to keep that file under the 400-line module gate.
 * Reuses ensureTaskRunStore + resolveCoordinationBackend from task-runs.ts.
 */

import { getDb } from '@los/infra/db';
import { resolveCoordinationBackend } from '../coordination/resolve.js';
import { ensureTaskRunStore, type TaskRunRecord, type TaskRunStatus } from '../task-runs.js';

export interface ClaimedBlockedTaskRun {
  taskRun: TaskRunRecord;
  askMessageId: string;
  answer: string;
  question: string;
  /** dispatch_id of the attempt that emitted the ask (= task_attempts.id). */
  dispatchId: string;
  /** agent_task fields needed to rebuild the resume input (graph path). */
  graphId?: string;
  agentTaskId?: string;
  provider?: string;
  model?: string;
}

/**
 * Claim blocked task_runs whose `ask` worker message has been answered and not yet
 * consumed. Marks the ask message consumed (payload.consumed_at = now()) in the same
 * statement so a concurrent scheduler tick cannot double-resume. Reuses the
 * advisory-lock pattern from recoverExpiredTaskRunsWithAdvisoryLock.
 *
 * Join path: task_runs → task_attempts (task_run_id) → worker_messages (dispatch_id).
 * dispatch_id = task_attempts.id, which is stable per attempt — the ask message is
 * emitted by the same attempt that blocked, so the join always lands.
 *
 * Single statement (pg extended protocol runs one query per pool.query): the CTE
 * marks the ask messages consumed AND returns the joined rows in one go.
 * Concurrency is serialized by the advisory lock, so no FOR UPDATE needed.
 */
export async function claimBlockedTaskRunsWithAnswer(
  opts: { graphId?: string; limit?: number } = {},
): Promise<ClaimedBlockedTaskRun[]> {
  const limit = opts.limit ?? 10;
  const graphId = opts.graphId;
  await ensureTaskRunStore();
  const backend = await resolveCoordinationBackend();
  const result = await backend.lock.withLock('task-run-blocked-resume', async () => {
    const db = getDb();
    const rows = await db.query<{
      id: string;
      session_id: string;
      run_spec_id?: string;
      trace_id: string;
      dedupe_key?: string;
      tenant_id?: string;
      project_id?: string;
      user_id?: string;
      node_id?: string;
      request_id?: string;
      workspace_root: string;
      tool_mode: string;
      provider?: string;
      model?: string;
      status: string;
      attempt: number;
      prompt_preview: string;
      metadata_json: Record<string, unknown>;
      created_at: string;
      updated_at: string;
      started_at?: string;
      completed_at?: string;
      heartbeat_at?: string;
      lease_expires_at?: string;
      ask_message_id: string;
      answer: string;
      question: string;
      dispatch_id: string;
      graph_id?: string;
      task_id?: string;
      ta_provider?: string;
      ta_model?: string;
    }>(
      /* sql */ `
      WITH consumed AS (
        UPDATE worker_messages AS wm
          SET payload_json = jsonb_set(payload_json, '{consumed_at}', to_jsonb(now()::timestamptz::text))
          FROM task_runs tr, task_attempts ta
          WHERE tr.id = ta.task_run_id
            AND ta.id = wm.dispatch_id
            AND wm.type = 'ask'
            AND tr.status = 'blocked'
            AND wm.payload_json->>'answer' IS NOT NULL
            AND wm.payload_json->>'consumed_at' IS NULL
            ${graphId ? 'AND ta.graph_id = $2' : ''}
          RETURNING wm.id AS ask_message_id, wm.payload_json->>'answer' AS answer, wm.payload_json->>'question' AS question, ta.id AS dispatch_id, ta.graph_id AS graph_id, ta.task_id AS task_id, ta.provider AS ta_provider, ta.model AS ta_model, tr.id AS tr_id
      )
      SELECT tr.*, c.ask_message_id, c.answer, c.question, c.dispatch_id, c.graph_id, c.task_id, c.ta_provider, c.ta_model
        FROM task_runs tr
        JOIN consumed c ON c.tr_id = tr.id
        ORDER BY tr.created_at
        LIMIT $1
      `,
        graphId ? [limit, graphId] : [limit],
    );
    return rows.rows.map(r => ({
      taskRun: {
        id: r.id,
        sessionId: r.session_id,
        runSpecId: r.run_spec_id,
        traceId: r.trace_id,
        dedupeKey: r.dedupe_key,
        tenantId: r.tenant_id,
        projectId: r.project_id,
        userId: r.user_id,
        nodeId: r.node_id,
        requestId: r.request_id,
        workspaceRoot: r.workspace_root,
        toolMode: r.tool_mode,
        provider: r.provider,
        model: r.model,
        status: r.status as TaskRunStatus,
        attempt: r.attempt,
        promptPreview: r.prompt_preview,
        metadata: r.metadata_json,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
        startedAt: r.started_at,
        completedAt: r.completed_at,
        heartbeatAt: r.heartbeat_at,
        leaseExpiresAt: r.lease_expires_at,
      },
      askMessageId: r.ask_message_id,
      answer: r.answer,
      question: r.question,
      dispatchId: r.dispatch_id,
      graphId: r.graph_id,
      agentTaskId: r.task_id,
      provider: r.ta_provider ?? undefined,
      model: r.ta_model ?? undefined,
    }));
  });
  return result ?? [];
}
