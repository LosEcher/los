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
import {
  listSessionEvents,
  listSessionEventsSince,
  type SessionEventRecord,
} from './session-events.js';
import { getDb } from '@los/infra/db';
import { type Message } from './providers/types.js';
import { findRecoveryCheckpoint } from './session-recovery-checkpoints.js';
import {
  buildMessagesFromEvents,
  classifyRecoveryMode,
  countLostToolResults,
  countTurnsAfterCheckpoint,
  detectStaleFiles,
} from './session-recovery-context.js';

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

  const errorEvents: RecoveryOutput['recoverySummary']['errorEvents'] = [];

  // ── Step 1: Find the most recent valid checkpoint ──
  const checkpoint = await findRecoveryCheckpoint(sessionId, input.targetCheckpointId).catch(err => {
    errorEvents.push({
      type: 'checkpoint_lookup_failed',
      message: err instanceof Error ? err.message : String(err),
      at: new Date().toISOString(),
    });
    return null;
  });

  if (!checkpoint) {
    const target = input.targetCheckpointId ? ` checkpoint ${input.targetCheckpointId}` : ' checkpoint';
    throw new Error(
      `No valid${target} found for session ${sessionId}. ` +
      'The session may have no compaction or stream checkpoint records.',
    );
  }

  // ── Step 2: Load session events from checkpoint cursor ──
  const events = await loadEventsSinceCheckpoint(sessionId, checkpoint, errorEvents);

  // ── Step 3: Build message array ──
  const messages = buildMessagesFromEvents(
    sessionId,
    checkpoint,
    events,
    includeSystemMessages,
  );

  // ── Step 4: Detect stale files ──
  const fileStaleness = await detectStaleFiles(checkpoint.fileReferences);

  // ── Step 5: Calculate recovery stats ──
  const lostToolResults = countLostToolResults(messages, checkpoint);
  const recoveryMode = classifyRecoveryMode(
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

// ── Event loading ──────────────────────────────────────────────

async function loadEventsSinceCheckpoint(
  sessionId: string,
  checkpoint: CheckpointSnapshot,
  errorEvents: RecoveryOutput['recoverySummary']['errorEvents'],
): Promise<SessionEventRecord[]> {
  try {
    const cursorIndex = checkpoint.messageCursor.lastEventIndex;
    if (cursorIndex > 0) {
      return await listSessionEventsSince(sessionId, cursorIndex, 500);
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
