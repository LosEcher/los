/**
 * @los/agent/worker-messages — Structured coordinator↔worker communication.
 *
 * The table `worker_messages` exists in the public schema (created by migration
 * 026_worker_messages.sql). This module provides typed CRUD for the four message
 * types defined in the worker contract:
 *
 *   worker_done  – worker finished a dispatch (success or failure), carries summary
 *   escalation   – worker needs human/upstream intervention
 *   ask          – worker is blocked on a coordinator decision
 *   heartbeat    – periodic liveness ping, optionally with a phase label
 *
 * Coordination model:
 *   - `dispatch_id` = the `task_attempts.id` of the active execution.
 *   - Each retry creates a new attempt → new dispatch_id → messages from a stale
 *     dispatch never collide with the current one.
 *   - Messages are append-only (no update, no delete). They form an event-sourced
 *     audit trail of worker↔coordinator interaction.
 *
 * Wiring status (as of 2026-07-03):
 *   - `worker_done` is the only type wired to a production caller: `runClaimedAgentGraphTask`
 *     in scheduler.ts emits it at the succeeded/failed/cancelled/error/recoveryFollowUp exits.
 *   - `heartbeat` is emitted from `task-heartbeat.ts` via `sendHeartbeat()` when a
 *     dispatch_id is available, alongside the existing DB lease extension.
 *   - `ask` is emitted by the `ask_coordinator` built-in tool (tools/builtin/worker-ask-tools.ts);
 *     the worker then blocks the task_run and the coordinator answers via
 *     `recordWorkerAnswer()` (called by the gateway POST /runs/:id/answer route).
 *   - `escalation` is emitted by the `escalate` built-in tool; the worker blocks the
 *     task_run and the operator intervenes via the existing recover/steering flow.
 *
 * Append-only exception: the `ask` row's `payload.answer` and `payload.consumed_at`
 * fields are mutable — `recordWorkerAnswer()` UPDATEs the answer field, and
 * `claimBlockedTaskRunsWithAnswer()` marks `consumed_at` when it resumes. The rest of
 * the row (type, question, created_at, dispatch_id) is immutable. This keeps the ask
 * row as the single source for both the question and its answer; consumers do not need
 * to join a separate answer-message type. The `worker.answered` session event (emitted
 * by the gateway route) records *when* the answer arrived for the audit trail.
 */

import { getDb } from '@los/infra/db';
import { randomUUID } from 'node:crypto';

// ── Types ──────────────────────────────────────────────────────

export type WorkerMessageType = 'worker_done' | 'escalation' | 'ask' | 'heartbeat';

export interface WorkerMessagePayload {
  summary?: string;       // worker_done: what was done/found/remaining
  reason?: string;        // escalation: why intervention is needed
  question?: string;      // ask: the blocking question
  options?: string[];     // ask: allowed answers
  answer?: string;        // ask: the coordinator's response — set by recordWorkerAnswer() (mutable)
  consumed_at?: string;   // ask: ISO timestamp when claimBlockedTaskRunsWithAnswer resumed (mutable)
  phase?: string;         // heartbeat: what the worker is currently doing
  error?: string;         // worker_done (failure): error message
  files_modified?: string[]; // worker_done: files touched
  metadata?: Record<string, unknown>;
}

export interface WorkerMessage {
  id: string;
  dispatchId?: string;
  taskId?: string;
  type: WorkerMessageType;
  payload: WorkerMessagePayload;
  createdAt: string;
}

interface WorkerMessageRow {
  id: string;
  dispatch_id?: string;
  task_id?: string;
  type: string;
  payload_json: Record<string, unknown>;
  created_at: string;
}

// ── Schema ──────────────────────────────────────────────────────

export const WORKER_MESSAGE_SCHEMA = `
CREATE TABLE IF NOT EXISTS worker_messages (
  id TEXT PRIMARY KEY,
  dispatch_id TEXT,
  task_id TEXT,
  type TEXT NOT NULL DEFAULT 'heartbeat',
  payload_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'worker_messages_type_chk'
      AND conrelid = 'worker_messages'::regclass
  ) THEN
    ALTER TABLE worker_messages
      ADD CONSTRAINT worker_messages_type_chk
      CHECK (type IN ('worker_done', 'escalation', 'ask', 'heartbeat'))
      NOT VALID;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_worker_messages_dispatch ON worker_messages(dispatch_id);
CREATE INDEX IF NOT EXISTS idx_worker_messages_task ON worker_messages(task_id);
CREATE INDEX IF NOT EXISTS idx_worker_messages_type ON worker_messages(type);
`;

let _initialized = false;

export async function ensureWorkerMessageStore(): Promise<void> {
  if (_initialized) return;
  const db = getDb();
  // SCHEMA carries the CREATE TABLE, CHECK constraint (DO $$ ... NOT VALID),
  // and indexes in one db.exec — matching the governance-jobs-schema.ts pattern.
  // Do NOT swallow a failure here: if the CHECK constraint cannot be added the
  // type contract would be silently unenforced, so let the rejection propagate.
  await db.exec(WORKER_MESSAGE_SCHEMA);
  _initialized = true;
}

// ── CRUD ────────────────────────────────────────────────────────

function rowToMessage(row: WorkerMessageRow): WorkerMessage {
  return {
    id: row.id,
    dispatchId: row.dispatch_id,
    taskId: row.task_id,
    type: row.type as WorkerMessageType,
    payload: row.payload_json as WorkerMessagePayload,
    createdAt: row.created_at,
  };
}

export interface SendWorkerMessageInput {
  dispatchId?: string;
  taskId?: string;
  type: WorkerMessageType;
  payload: WorkerMessagePayload;
}

/**
 * Append a worker message. Idempotent — the caller provides or auto-generates
 * the id. Returns the created message.
 */
export async function sendWorkerMessage(
  input: SendWorkerMessageInput,
): Promise<WorkerMessage> {
  await ensureWorkerMessageStore();
  const db = getDb();
  const id = randomUUID();
  const rows = await db.query<WorkerMessageRow>(
    /* sql */ `
    INSERT INTO worker_messages (id, dispatch_id, task_id, type, payload_json)
    VALUES ($1, $2, $3, $4, $5)
    RETURNING *
  `,
    [id, input.dispatchId ?? null, input.taskId ?? null, input.type, JSON.stringify(input.payload)],
  );
  return rowToMessage(rows.rows[0]!);
}

/**
 * List worker messages for a dispatch, ordered by creation time ascending.
 */
export async function listMessagesForDispatch(
  dispatchId: string,
  opts?: { type?: WorkerMessageType; limit?: number },
): Promise<WorkerMessage[]> {
  await ensureWorkerMessageStore();
  const db = getDb();
  const typeFilter = opts?.type ? 'AND type = $2' : '';
  const params: (string | number)[] = [dispatchId];
  if (opts?.type) params.push(opts.type);
  params.push(opts?.limit ?? 100);

  const rows = await db.query<WorkerMessageRow>(
    /* sql */ `
    SELECT * FROM worker_messages
    WHERE dispatch_id = $1 ${typeFilter}
    ORDER BY created_at ASC
    LIMIT $${params.length}
  `,
    params,
  );
  return rows.rows.map(rowToMessage);
}

/**
 * List worker messages for a task (across all dispatches), ordered by creation time descending.
 */
export async function listMessagesForTask(
  taskId: string,
  opts?: { type?: WorkerMessageType; limit?: number },
): Promise<WorkerMessage[]> {
  await ensureWorkerMessageStore();
  const db = getDb();
  const typeFilter = opts?.type ? 'AND type = $2' : '';
  const params: (string | number)[] = [taskId];
  if (opts?.type) params.push(opts.type);
  params.push(opts?.limit ?? 100);

  const rows = await db.query<WorkerMessageRow>(
    /* sql */ `
    SELECT * FROM worker_messages
    WHERE task_id = $1 ${typeFilter}
    ORDER BY created_at DESC
    LIMIT $${params.length}
  `,
    params,
  );
  return rows.rows.map(rowToMessage);
}

/**
 * Check whether a dispatch has a worker_done message.
 * When the worker contract is enforced, completion authority belongs to
 * worker_done, not just task status.
 */
export async function hasWorkerDone(dispatchId: string): Promise<boolean> {
  await ensureWorkerMessageStore();
  const db = getDb();
  const rows = await db.query<{ count: string }>(
    `SELECT COUNT(*) as count FROM worker_messages WHERE dispatch_id = $1 AND type = 'worker_done'`,
    [dispatchId],
  );
  return parseInt(rows.rows[0]!.count, 10) > 0;
}

/**
 * Record the coordinator's answer on an `ask` message. This is the one mutable
 * operation on the worker_messages table: it UPDATEs the ask row's payload.answer
 * (see the append-only exception in the module header). Idempotent — answering the
 * same messageId twice just overwrites the same answer field. Returns the updated
 * message, or undefined if no matching ask row exists (wrong id / already consumed
 * is NOT a reason for undefined — only "no such ask row").
 */
export async function recordWorkerAnswer(
  messageId: string,
  answer: string,
): Promise<WorkerMessage | undefined> {
  await ensureWorkerMessageStore();
  const db = getDb();
  const rows = await db.query<WorkerMessageRow>(
    /* sql */ `
    UPDATE worker_messages
      SET payload_json = jsonb_set(payload_json, '{answer}', to_jsonb($2::text))
    WHERE id = $1 AND type = 'ask'
    RETURNING *
  `,
    [messageId, answer],
  );
  return rows.rows.length > 0 ? rowToMessage(rows.rows[0]!) : undefined;
}

/**
 * Convenience: send a heartbeat message.
 */
export async function sendHeartbeat(input: {
  dispatchId: string;
  taskId?: string;
  phase?: string;
  metadata?: Record<string, unknown>;
}): Promise<WorkerMessage> {
  return sendWorkerMessage({
    dispatchId: input.dispatchId,
    taskId: input.taskId,
    type: 'heartbeat',
    payload: { phase: input.phase, metadata: input.metadata },
  });
}
