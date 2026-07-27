/**
 * @los/agent/session-recovery — Session context reconstruction for interrupted agent runs.
 *
 * Problem: When a session is interrupted (gateway restart, process crash, network loss),
 * the replacement agent has no context — it doesn't know what was done, what tools are
 * mid-flight, or which files were being edited.
 *
 * Solution: reconstitute the full message array from the last valid checkpoint by
 * reading session_events (audit log), stream_checkpoints (high-frequency event log),
 * and memory_compactions (compaction metadata including tool state snapshots).
 *
 * Contract: contracts/session-recovery.yaml v0.1.0
 */

import { getLogger } from '@los/infra/logger';
import { listSessionEvents, type SessionEventRecord } from './session-events.js';
import { listStreamCheckpointsSince } from './stream-checkpoints.js';
import { getDb } from '@los/infra/db';
import { type Message } from './providers/types.js';

const log = getLogger('session-recovery');

// ── Types (aligned with contracts/session-recovery.yaml) ────────

export interface CheckpointSnapshot {
  checkpointId: string;
  sessionId: string;
  runSpecId: string | null;
  takenAt: string;
  trigger: string;
  mode: 'checkpoint' | 'full';
  toolState: {
    pendingCalls: Array<{
      callId: string;
      toolName: string;
      args: Record<string, unknown>;
      status: 'requested' | 'running' | 'succeeded' | 'failed';
    }>;
    lastResult: Array<{
      callId: string;
      toolName: string;
      outcome: 'success' | 'error' | 'cancelled';
      resultSummary: string;
    }>;
  };
  fileReferences: Array<{
    path: string;
    contentHash: string;
    lastOperation: 'read' | 'write' | 'edit';
  }>;
  messageCursor: {
    lastEventId: string;
    lastEventIndex: number;
    turnCount: number;
  };
}

export interface RecoveryInput {
  sessionId: string;
  targetCheckpointId?: string;
  includeSystemMessages?: boolean;
}

export interface RecoveryStaleFile {
  path: string;
  checkpointHash: string;
  currentHash?: string;
  stale: boolean;
}

export interface RecoveryOutput {
  sessionId: string;
  checkpointId: string;
  messages: Message[];
  recoverySummary: {
    recoveredTurnCount: number;
    totalTurnCount: number;
    lostToolResults: number;
    fileStaleness: RecoveryStaleFile[];
    recoveryMode: 'full' | 'partial' | 'degraded';
    errorEvents: Array<{ type: string; message: string; at: string }>;
  };
}

// ── Reconstruction ────────────────────────────────────────────

/**
 * Reconstruct a complete message array from the last valid checkpoint
 * for a session. The output is ready for provider.chat({ messages }).
 *
 * Steps:
 * 1. Find the most recent valid checkpoint (compaction or stream checkpoint)
 * 2. Load session events from the checkpoint cursor forward
 * 3. Build message array: system handoff → user/assistant → tool calls
 * 4. Detect stale files and lost tool results
 * 5. Classify recovery mode (full/partial/degraded)
 */
// ── Local memory compaction store init ─────────────────────────
// Duplicates the SCHEMA from @los/memory to avoid cross-package import.
// The agent package does not depend on @los/memory; the table DDL is small.

let _compactionStoreInitialized = false;

async function ensureMemoryCompactionStoreLocally(): Promise<void> {
  if (_compactionStoreInitialized) return;
  const db = getDb();
  await db.exec(`
    CREATE TABLE IF NOT EXISTS memory_compactions (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      run_spec_id TEXT,
      tenant_id TEXT,
      project_id TEXT,
      summary_json JSONB NOT NULL DEFAULT '{}'::jsonb,
      observed_patterns_json JSONB NOT NULL DEFAULT '[]'::jsonb,
      procedural_candidates_json JSONB NOT NULL DEFAULT '[]'::jsonb,
      confidence NUMERIC NOT NULL DEFAULT 0,
      evidence_count INTEGER NOT NULL DEFAULT 0,
      created_by TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    ALTER TABLE memory_compactions ADD COLUMN IF NOT EXISTS tenant_id TEXT;
    ALTER TABLE memory_compactions ADD COLUMN IF NOT EXISTS project_id TEXT;
    ALTER TABLE memory_compactions ADD COLUMN IF NOT EXISTS auto_trigger TEXT;
    ALTER TABLE memory_compactions ADD COLUMN IF NOT EXISTS transcript_brief_json JSONB;
    CREATE INDEX IF NOT EXISTS idx_memcomp_session ON memory_compactions(session_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_memcomp_tenant_project ON memory_compactions(tenant_id, project_id, created_at DESC);
  `);
  _compactionStoreInitialized = true;
  log.debug('Memory compaction store initialized (local)');
}


export async function reconstructSessionContext(
  input: RecoveryInput,
): Promise<RecoveryOutput> {
  const { sessionId, includeSystemMessages = true } = input;

  await ensureMemoryCompactionStoreLocally();
  const db = getDb();

  const errorEvents: RecoveryOutput['recoverySummary']['errorEvents'] = [];

  // ── Step 1: Find the most recent valid checkpoint ──
  const checkpoint = await findLatestCheckpoint(sessionId, errorEvents);

  if (!checkpoint) {
    throw new Error(
      `No valid checkpoint found for session ${sessionId}. ` +
      'The session may have no compaction or stream checkpoint records.',
    );
  }

  // ── Step 2: Load session events from checkpoint cursor ──
  const events = await loadEventsSinceCheckpoint(sessionId, checkpoint, errorEvents);
  const totalEvents = events.length;

  // ── Step 3: Build message array ──
  const messages = buildMessagesFromEvents(
    sessionId,
    checkpoint,
    events,
    includeSystemMessages,
    errorEvents,
  );

  // ── Step 4: Detect stale files ──
  const fileStaleness = await detectStaleFiles(
    checkpoint.fileReferences,
    errorEvents,
  );

  // ── Step 5: Calculate recovery stats ──
  const lostToolResults = countLostToolResults(messages, checkpoint, events);
  const recoveryMode = classifyRecoveryMode(
    totalEvents,
    lostToolResults,
    errorEvents.length,
    checkpoint,
  );

  return {
    sessionId,
    checkpointId: checkpoint.checkpointId,
    messages,
    recoverySummary: {
      recoveredTurnCount: checkpoint.messageCursor.turnCount,
      totalTurnCount: checkpoint.messageCursor.turnCount + countTurnsAfterCheckpoint(events),
      lostToolResults,
      fileStaleness,
      recoveryMode,
      errorEvents,
    },
  };
}

// ── Checkpoint discovery ───────────────────────────────────────

async function findLatestCheckpoint(
  sessionId: string,
  errorEvents: RecoveryOutput['recoverySummary']['errorEvents'],
): Promise<CheckpointSnapshot | null> {
  const db = getDb();

  // Try memory_compactions first (most reliable, has tool state)
  try {
    const compactions = await db.query<{
      id: string; session_id: string; run_spec_id: string | null;
      summary_json: Record<string, unknown>;
      created_at: string; auto_trigger: string | null;
    }>(
      `SELECT id, session_id, run_spec_id, summary_json, created_at, auto_trigger
       FROM memory_compactions
       WHERE session_id = $1
       ORDER BY created_at DESC
       LIMIT 1`,
      [sessionId],
    );

    if (compactions.rows[0]) {
      return checkpointFromCompaction(compactions.rows[0]);
    }
  } catch (err) {
    errorEvents.push({
      type: 'checkpoint_lookup_failed',
      message: `memory_compactions query failed: ${err instanceof Error ? err.message : String(err)}`,
      at: new Date().toISOString(),
    });
  }

  // Fallback: build from stream_checkpoints (event log)
  try {
    return await checkpointFromStreamEvents(sessionId, errorEvents);
  } catch (err) {
    errorEvents.push({
      type: 'stream_checkpoint_failed',
      message: err instanceof Error ? err.message : String(err),
      at: new Date().toISOString(),
    });
  }

  return null;
}

function checkpointFromCompaction(row: {
  id: string; session_id: string; run_spec_id: string | null;
  summary_json: Record<string, unknown>;
  created_at: string; auto_trigger: string | null;
}): CheckpointSnapshot {
  const summary = row.summary_json ?? {};
  const toolState = (summary as Record<string, unknown>).toolState;
  const fileRefs = (summary as Record<string, unknown>).fileReferences;
  const cursor = (summary as Record<string, unknown>).messageCursor;

  return {
    checkpointId: row.id,
    sessionId: row.session_id,
    runSpecId: row.run_spec_id,
    takenAt: row.created_at,
    trigger: row.auto_trigger ?? 'manual',
    mode: row.id.startsWith('chkpt-') ? 'checkpoint' : 'full',
    toolState: typeof toolState === 'object' && toolState !== null
      ? toolState as CheckpointSnapshot['toolState']
      : { pendingCalls: [], lastResult: [] },
    fileReferences: Array.isArray(fileRefs)
      ? fileRefs as CheckpointSnapshot['fileReferences']
      : [],
    messageCursor: typeof cursor === 'object' && cursor !== null
      ? cursor as CheckpointSnapshot['messageCursor']
      : { lastEventId: '', lastEventIndex: 0, turnCount: 0 },
  };
}

async function checkpointFromStreamEvents(
  sessionId: string,
  errorEvents: RecoveryOutput['recoverySummary']['errorEvents'],
): Promise<CheckpointSnapshot | null> {
  try {
    const records = await listStreamCheckpointsSince(sessionId, 0, 1);
    if (records.length === 0) return null;

    const latest = records[records.length - 1];
    const turn = typeof latest.turn === 'number' ? latest.turn : 0;

    return {
      checkpointId: `stream-${sessionId}-${latest.id}`,
      sessionId,
      runSpecId: latest.runSpecId ?? null,
      takenAt: latest.createdAt,
      trigger: 'event_count',
      mode: 'checkpoint',
      toolState: {
        pendingCalls: extractPendingCallsFromPayload(latest.payload ?? {}),
        lastResult: [],
      },
      fileReferences: extractFileReferencesFromPayload(latest.payload ?? {}),
      messageCursor: {
        lastEventId: String(latest.id),
        lastEventIndex: latest.id,
        turnCount: turn,
      },
    };
  } catch (err) {
    errorEvents.push({
      type: 'stream_checkpoint_failed',
      message: err instanceof Error ? err.message : String(err),
      at: new Date().toISOString(),
    });
    return null;
  }
}

// ── Event loading ──────────────────────────────────────────────

async function loadEventsSinceCheckpoint(
  sessionId: string,
  checkpoint: CheckpointSnapshot,
  errorEvents: RecoveryOutput['recoverySummary']['errorEvents'],
): Promise<SessionEventRecord[]> {
  try {
    const cursorIndex = checkpoint.messageCursor.lastEventIndex;
    if (cursorIndex > 0) {
      const events = await listSessionEvents(sessionId, 500);
      return events.filter(e => e.id > cursorIndex);
    }
    return await listSessionEvents(sessionId, 200);
  } catch (err) {
    errorEvents.push({
      type: 'event_load_failed',
      message: err instanceof Error ? err.message : String(err),
      at: new Date().toISOString(),
    });
    return [];
  }
}

// ── Message building ───────────────────────────────────────────

function buildMessagesFromEvents(
  sessionId: string,
  checkpoint: CheckpointSnapshot,
  events: SessionEventRecord[],
  includeSystemMessages: boolean,
  errorEvents: RecoveryOutput['recoverySummary']['errorEvents'],
): Message[] {
  const messages: Message[] = [];

  // First message: recovery handoff system message
  const handoffMsg = buildHandoffMessage(sessionId, checkpoint);
  messages.push(handoffMsg);

  // System messages from events (if requested)
  if (includeSystemMessages) {
    for (const event of events) {
      if (event.type === 'session.resumed' || event.type === 'session.started') {
        const content = typeof event.payload?.content === 'string'
          ? event.payload.content : '';
        if (content) {
          messages.push({ role: 'system', content });
        }
      }
    }
  }

  // User + assistant messages from events
  // (session_events contains the audit trail; we extract the relevant ones)
  for (const event of events) {
    if (event.type === 'user.message') {
      const content = typeof event.payload?.content === 'string'
        ? event.payload.content : '';
      if (content) {
        messages.push({ role: 'user', content });
      }
    } else if (event.type === 'model.turn.completed') {
      const content = typeof event.payload?.content === 'string'
        ? event.payload.content : '';
      if (content) {
        messages.push({ role: 'assistant', content });
      }
    } else if (event.type === 'tool.execute' || event.type === 'tool.call') {
      const toolCall = event.payload as Record<string, unknown>;
      const toolCallId = (toolCall?.callId ?? toolCall?.id ?? `call_${event.id}`) as string;
      const toolName = (toolCall?.name ?? event.toolName ?? 'unknown') as string;

      // Assistant message with tool_calls
      messages.push({
        role: 'assistant',
        content: '',
        tool_calls: [{
          id: toolCallId,
          type: 'function',
          function: {
            name: toolName,
            arguments: JSON.stringify(toolCall?.args ?? {}),
          },
        }],
      } as Message);

      // Tool result — will be stubbed if lost
      const hasResult = event.source === 'loop' || event.payload?.result !== undefined;
      if (hasResult) {
        const resultContent = typeof event.payload?.result === 'string'
          ? event.payload.result
          : JSON.stringify(event.payload?.result ?? 'ok');
        messages.push({
          role: 'tool',
          tool_call_id: toolCallId,
          content: resultContent,
        } as Message);
      } else {
        // Stub for lost result
        messages.push({
          role: 'tool',
          tool_call_id: toolCallId,
          content: `[Tool result lost during session interruption. Tool "${toolName}" was in-flight at checkpoint.]`,
        } as Message);
      }
    }
  }

  return messages;
}

function buildHandoffMessage(
  sessionId: string,
  checkpoint: CheckpointSnapshot,
): Message {
  const completedCalls = checkpoint.toolState.lastResult
    .filter(r => r.outcome === 'success')
    .map(r => `  - ${r.toolName}: ${r.resultSummary}`);
  const pendingCalls = checkpoint.toolState.pendingCalls
    .map(c => `  - ${c.toolName} (${c.status})`);

  const completedBlock = completedCalls.length > 0
    ? `\nCompleted tool calls:\n${completedCalls.join('\n')}`
    : '\nNo completed tool calls at checkpoint.';
  const pendingBlock = pendingCalls.length > 0
    ? `\nIn-progress tool calls:\n${pendingCalls.join('\n')}`
    : '\nNo in-progress tool calls at checkpoint.';
  const fileBlock = checkpoint.fileReferences.length > 0
    ? `\nReferenced files (may be stale, re-read before editing):\n${checkpoint.fileReferences.map(f => `  - ${f.path} (${f.lastOperation})`).join('\n')}`
    : '';

  return {
    role: 'system',
    content:
      `You are resuming session ${sessionId} from checkpoint ${checkpoint.checkpointId} ` +
      `taken at ${checkpoint.takenAt}.` +
      completedBlock +
      pendingBlock +
      fileBlock +
      `\n\nContinue the work from this checkpoint. Re-read stale files before making changes.`,
  };
}

// ── File staleness detection ───────────────────────────────────

async function detectStaleFiles(
  fileReferences: CheckpointSnapshot['fileReferences'],
  errorEvents: RecoveryOutput['recoverySummary']['errorEvents'],
): Promise<RecoveryStaleFile[]> {
  if (fileReferences.length === 0) return [];

  const results: RecoveryStaleFile[] = [];
  const { createHash } = await import('node:crypto');
  const { readFile } = await import('node:fs/promises');

  for (const ref of fileReferences) {
    try {
      const content = await readFile(ref.path, 'utf-8');
      const currentHash = createHash('sha256').update(content).digest('hex');
      results.push({
        path: ref.path,
        checkpointHash: ref.contentHash,
        currentHash,
        stale: currentHash !== ref.contentHash,
      });
    } catch {
      // File may have been deleted or moved — mark stale
      results.push({
        path: ref.path,
        checkpointHash: ref.contentHash,
        stale: true,
      });
    }
  }

  return results;
}

// ── Recovery classification ────────────────────────────────────

function countLostToolResults(
  messages: Message[],
  checkpoint: CheckpointSnapshot,
  _events: SessionEventRecord[],
): number {
  let lost = 0;
  for (const msg of messages) {
    if (msg.role === 'tool' && typeof msg.content === 'string' &&
        msg.content.includes('[Tool result lost during session interruption')) {
      lost += 1;
    }
  }
  // Also count pending calls that never got results
  lost += checkpoint.toolState.pendingCalls.filter(
    c => c.status === 'requested' || c.status === 'running',
  ).length;
  return lost;
}

function classifyRecoveryMode(
  totalEvents: number,
  lostToolResults: number,
  errorCount: number,
  checkpoint: CheckpointSnapshot,
): RecoveryOutput['recoverySummary']['recoveryMode'] {
  if (errorCount > 2) return 'degraded';
  if (lostToolResults > 0 || totalEvents === 0) return 'partial';
  if (checkpoint.toolState.pendingCalls.length > 0) return 'partial';
  return 'full';
}

function countTurnsAfterCheckpoint(
  events: SessionEventRecord[],
): number {
  const turns = new Set(events.map(e => e.turn));
  return turns.size;
}

// ── Stream checkpoint extraction helpers ────────────────────────

function extractPendingCallsFromPayload(
  payload: Record<string, unknown>,
): CheckpointSnapshot['toolState']['pendingCalls'] {
  const calls = payload.pendingCalls;
  if (Array.isArray(calls)) {
    return calls.map((c: Record<string, unknown>) => ({
      callId: String(c.callId ?? ''),
      toolName: String(c.toolName ?? ''),
      args: typeof c.args === 'object' && c.args !== null ? c.args as Record<string, unknown> : {},
      status: (c.status as CheckpointSnapshot['toolState']['pendingCalls'][0]['status']) ?? 'requested',
    }));
  }
  return [];
}

function extractFileReferencesFromPayload(
  payload: Record<string, unknown>,
): CheckpointSnapshot['fileReferences'] {
  const refs = payload.fileReferences;
  if (Array.isArray(refs)) {
    return refs.map((r: Record<string, unknown>) => ({
      path: String(r.path ?? ''),
      contentHash: String(r.contentHash ?? ''),
      lastOperation: (r.lastOperation as 'read' | 'write' | 'edit') ?? 'read',
    }));
  }
  return [];
}
