import { getDb } from '@los/infra/db';
import {
  _getLatestStreamCheckpoint,
  _getStreamCheckpointById,
  type StreamCheckpointRecord,
} from './stream-checkpoints.js';
import type { CheckpointSnapshot } from './session-recovery.js';

export interface CompactionCheckpointRow {
  id: string;
  session_id: string;
  run_spec_id: string | null;
  summary_json: Record<string, unknown>;
  created_at: Date | string;
  auto_trigger: string | null;
}

export interface RecoveryCheckpointSources {
  getLatestCompaction(sessionId: string): Promise<CompactionCheckpointRow | null>;
  getCompactionById(sessionId: string, checkpointId: string): Promise<CompactionCheckpointRow | null>;
  getLatestStream(sessionId: string): Promise<StreamCheckpointRecord | null>;
  getStreamById(sessionId: string, checkpointId: number): Promise<StreamCheckpointRecord | null>;
}

const defaultSources: RecoveryCheckpointSources = {
  async getLatestCompaction(sessionId) {
    const rows = await getDb().query<CompactionCheckpointRow>(
      `SELECT id, session_id, run_spec_id, summary_json, created_at, auto_trigger
       FROM memory_compactions
       WHERE session_id = $1
       ORDER BY created_at DESC, id DESC
       LIMIT 1`,
      [sessionId],
    );
    return rows.rows[0] ?? null;
  },
  async getCompactionById(sessionId, checkpointId) {
    const rows = await getDb().query<CompactionCheckpointRow>(
      `SELECT id, session_id, run_spec_id, summary_json, created_at, auto_trigger
       FROM memory_compactions
       WHERE session_id = $1 AND id = $2
       LIMIT 1`,
      [sessionId, checkpointId],
    );
    return rows.rows[0] ?? null;
  },
  getLatestStream: sessionId => _getLatestStreamCheckpoint(sessionId),
  getStreamById: (sessionId, checkpointId) => _getStreamCheckpointById(sessionId, checkpointId),
};

export async function findRecoveryCheckpoint(
  sessionId: string,
  targetCheckpointId?: string,
  sources: RecoveryCheckpointSources = defaultSources,
): Promise<CheckpointSnapshot | null> {
  if (targetCheckpointId) {
    const streamId = parseStreamCheckpointId(sessionId, targetCheckpointId);
    if (streamId !== null) {
      const record = await sources.getStreamById(sessionId, streamId);
      return record ? checkpointFromStreamRecord(record) : null;
    }
    const row = await sources.getCompactionById(sessionId, targetCheckpointId);
    return row ? checkpointFromCompaction(row) : null;
  }

  const [compactionResult, streamResult] = await Promise.allSettled([
    sources.getLatestCompaction(sessionId),
    sources.getLatestStream(sessionId),
  ]);
  if (compactionResult.status === 'rejected' && streamResult.status === 'rejected') {
    throw new AggregateError(
      [compactionResult.reason, streamResult.reason],
      `Checkpoint sources failed for session ${sessionId}`,
    );
  }
  const compaction = compactionResult.status === 'fulfilled' ? compactionResult.value : null;
  const stream = streamResult.status === 'fulfilled' ? streamResult.value : null;
  return selectLatestCheckpoint(
    compaction ? checkpointFromCompaction(compaction) : null,
    stream ? checkpointFromStreamRecord(stream) : null,
  );
}

function selectLatestCheckpoint(
  compaction: CheckpointSnapshot | null,
  stream: CheckpointSnapshot | null,
): CheckpointSnapshot | null {
  if (!compaction) return stream;
  if (!stream) return compaction;
  const streamTime = Date.parse(stream.takenAt);
  const compactionTime = Date.parse(compaction.takenAt);
  if (!Number.isFinite(streamTime)) return compaction;
  if (!Number.isFinite(compactionTime)) return stream;
  return streamTime > compactionTime ? stream : compaction;
}

function checkpointFromCompaction(row: CompactionCheckpointRow): CheckpointSnapshot {
  const summary = row.summary_json ?? {};
  const toolState = summary.toolState;
  const fileReferences = summary.fileReferences;
  const messageCursor = summary.messageCursor;

  return {
    checkpointId: row.id,
    sessionId: row.session_id,
    runSpecId: row.run_spec_id,
    takenAt: toIsoString(row.created_at),
    trigger: row.auto_trigger ?? 'manual',
    mode: row.id.startsWith('chkpt-') ? 'checkpoint' : 'full',
    toolState: isRecord(toolState)
      ? toolState as unknown as CheckpointSnapshot['toolState']
      : { pendingCalls: [], lastResult: [] },
    fileReferences: Array.isArray(fileReferences)
      ? fileReferences as CheckpointSnapshot['fileReferences']
      : [],
    messageCursor: isRecord(messageCursor)
      ? messageCursor as unknown as CheckpointSnapshot['messageCursor']
      : { lastEventId: '', lastEventIndex: 0, turnCount: 0 },
  };
}

function checkpointFromStreamRecord(record: StreamCheckpointRecord): CheckpointSnapshot | null {
  const messageCursor = extractMessageCursor(record.payload);
  if (!messageCursor) return null;
  return {
    checkpointId: `stream-${record.sessionId}-${record.id}`,
    sessionId: record.sessionId,
    runSpecId: record.runSpecId ?? null,
    takenAt: record.createdAt,
    trigger: String(record.payload.trigger ?? 'event_count'),
    mode: record.payload.mode === 'full' ? 'full' : 'checkpoint',
    toolState: {
      pendingCalls: extractPendingCalls(record.payload),
      lastResult: extractLastResults(record.payload),
    },
    fileReferences: extractFileReferences(record.payload),
    messageCursor,
  };
}

function parseStreamCheckpointId(sessionId: string, checkpointId: string): number | null {
  const prefix = `stream-${sessionId}-`;
  if (!checkpointId.startsWith(prefix)) return null;
  const value = Number(checkpointId.slice(prefix.length));
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function extractPendingCalls(payload: Record<string, unknown>): CheckpointSnapshot['toolState']['pendingCalls'] {
  const toolState = isRecord(payload.toolState) ? payload.toolState : {};
  if (!Array.isArray(toolState.pendingCalls)) return [];
  return toolState.pendingCalls.map(value => {
    const call = isRecord(value) ? value : {};
    return {
      callId: String(call.callId ?? ''),
      toolName: String(call.toolName ?? ''),
      args: isRecord(call.args) ? call.args : {},
      status: (call.status as CheckpointSnapshot['toolState']['pendingCalls'][number]['status']) ?? 'requested',
    };
  });
}

function extractLastResults(payload: Record<string, unknown>): CheckpointSnapshot['toolState']['lastResult'] {
  const toolState = isRecord(payload.toolState) ? payload.toolState : {};
  if (!Array.isArray(toolState.lastResult)) return [];
  return toolState.lastResult.map(value => {
    const result = isRecord(value) ? value : {};
    return {
      callId: String(result.callId ?? ''),
      toolName: String(result.toolName ?? ''),
      outcome: (result.outcome as CheckpointSnapshot['toolState']['lastResult'][number]['outcome']) ?? 'error',
      resultSummary: String(result.resultSummary ?? ''),
    };
  });
}

function extractFileReferences(payload: Record<string, unknown>): CheckpointSnapshot['fileReferences'] {
  if (!Array.isArray(payload.fileReferences)) return [];
  return payload.fileReferences.map(value => {
    const reference = isRecord(value) ? value : {};
    return {
      path: String(reference.path ?? ''),
      contentHash: String(reference.contentHash ?? ''),
      lastOperation: (reference.lastOperation as 'read' | 'write' | 'edit') ?? 'read',
    };
  });
}

function extractMessageCursor(payload: Record<string, unknown>): CheckpointSnapshot['messageCursor'] | null {
  if (!isRecord(payload.messageCursor)) return null;
  const lastEventIndex = Number(payload.messageCursor.lastEventIndex);
  const turnCount = Number(payload.messageCursor.turnCount);
  if (!Number.isSafeInteger(lastEventIndex) || lastEventIndex < 0) return null;
  if (!Number.isSafeInteger(turnCount) || turnCount < 0) return null;
  return {
    lastEventId: String(payload.messageCursor.lastEventId ?? lastEventIndex),
    lastEventIndex,
    turnCount,
  };
}

function toIsoString(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
