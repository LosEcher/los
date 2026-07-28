import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import type { Message } from './providers/types.js';
import type { SessionEventRecord } from './session-events.js';
import type {
  CheckpointSnapshot,
  RecoveryOutput,
  RecoveryStaleFile,
} from './session-recovery.js';

type RecoveryMode = RecoveryOutput['recoverySummary']['recoveryMode'];

export function buildMessagesFromEvents(
  sessionId: string,
  checkpoint: CheckpointSnapshot,
  events: SessionEventRecord[],
  includeSystemMessages: boolean,
): Message[] {
  const messages: Message[] = [_buildHandoffMessage(sessionId, checkpoint)];
  const pendingCalls = new Map<string, string>();

  for (const event of events) {
    if (includeSystemMessages && (event.type === 'session.resumed' || event.type === 'session.started')) {
      const content = readText(event.payload, ['content', 'message']);
      if (content) messages.push({ role: 'system', content });
      continue;
    }
    if (event.type === 'user.message') {
      const content = readText(event.payload, ['content', 'message']);
      if (content) messages.push({ role: 'user', content });
      continue;
    }
    if (event.type === 'model.turn.completed') {
      const content = readText(event.payload, ['content', 'text', 'textPreview']);
      if (content) messages.push({ role: 'assistant', content });
      continue;
    }
    if (event.type === 'tool.execute' || event.type === 'tool.call') {
      const callId = String(event.payload.callId ?? event.payload.id ?? `call_${event.id}`);
      const toolName = String(event.payload.name ?? event.toolName ?? 'unknown');
      pendingCalls.set(callId, toolName);
      messages.push({
        role: 'assistant',
        content: '',
        tool_calls: [{
          id: callId,
          type: 'function',
          function: {
            name: toolName,
            arguments: JSON.stringify(event.payload.args ?? {}),
          },
        }],
      } as Message);
      if (event.payload.result !== undefined) {
        messages.push(toolResultMessage(callId, event.payload.result));
        pendingCalls.delete(callId);
      }
      continue;
    }
    if (event.type === 'tool.result') {
      const callId = String(event.payload.callId ?? event.payload.id ?? '');
      if (!callId || !pendingCalls.has(callId)) continue;
      const content = readToolResult(event.payload);
      messages.push(toolResultMessage(callId, content));
      pendingCalls.delete(callId);
    }
  }

  for (const [callId, toolName] of pendingCalls) {
    messages.push(toolResultMessage(
      callId,
      `[Tool result lost during session interruption. Tool "${toolName}" was in-flight at checkpoint.]`,
    ));
  }
  return messages;
}

export function _buildHandoffMessage(
  sessionId: string,
  checkpoint: CheckpointSnapshot,
): Message {
  const completedCalls = checkpoint.toolState.lastResult
    .filter(result => result.outcome === 'success')
    .map(result => `  - ${result.toolName}: ${result.resultSummary}`);
  const pendingCalls = checkpoint.toolState.pendingCalls
    .map(call => `  - ${call.toolName} (${call.status})`);
  const completedBlock = completedCalls.length > 0
    ? `\nCompleted tool calls:\n${completedCalls.join('\n')}`
    : '\nNo completed tool calls at checkpoint.';
  const pendingBlock = pendingCalls.length > 0
    ? `\nIn-progress tool calls:\n${pendingCalls.join('\n')}`
    : '\nNo in-progress tool calls at checkpoint.';
  const fileBlock = checkpoint.fileReferences.length > 0
    ? `\nReferenced files (may be stale, re-read before editing):\n${checkpoint.fileReferences.map(reference => `  - ${reference.path} (${reference.lastOperation})`).join('\n')}`
    : '';

  return {
    role: 'system',
    content:
      `You are resuming session ${sessionId} from checkpoint ${checkpoint.checkpointId} ` +
      `taken at ${checkpoint.takenAt}.` + completedBlock + pendingBlock + fileBlock +
      '\n\nContinue the work from this checkpoint. Re-read stale files before making changes.',
  };
}

export async function detectStaleFiles(
  fileReferences: CheckpointSnapshot['fileReferences'],
): Promise<RecoveryStaleFile[]> {
  return Promise.all(fileReferences.map(async reference => {
    try {
      const content = await readFile(reference.path, 'utf-8');
      const currentHash = createHash('sha256').update(content).digest('hex');
      return {
        path: reference.path,
        checkpointHash: reference.contentHash,
        currentHash,
        stale: currentHash !== reference.contentHash,
      };
    } catch {
      return {
        path: reference.path,
        checkpointHash: reference.contentHash,
        stale: true,
      };
    }
  }));
}

export function countLostToolResults(
  messages: Message[],
  checkpoint: CheckpointSnapshot,
): number {
  const lostCallIds = new Set<string>();
  for (const message of messages) {
    if (message.role !== 'tool' || typeof message.content !== 'string') continue;
    if (!message.content.includes('[Tool result lost during session interruption')) continue;
    if (message.tool_call_id) lostCallIds.add(message.tool_call_id);
  }
  for (const call of checkpoint.toolState.pendingCalls) {
    if (call.status === 'requested' || call.status === 'running') lostCallIds.add(call.callId);
  }
  return lostCallIds.size;
}

export function classifyRecoveryMode(
  lostToolResults: number,
  errorCount: number,
  checkpoint: CheckpointSnapshot,
): RecoveryMode {
  if (errorCount > 2) return 'degraded';
  if (lostToolResults > 0 || checkpoint.toolState.pendingCalls.length > 0) return 'partial';
  return 'full';
}

export function countTurnsAfterCheckpoint(events: SessionEventRecord[]): number {
  return new Set(events.filter(event => event.turn > 0).map(event => event.turn)).size;
}

function toolResultMessage(callId: string, result: unknown): Message {
  return {
    role: 'tool',
    tool_call_id: callId,
    content: typeof result === 'string' ? result : JSON.stringify(result),
  } as Message;
}

function readToolResult(payload: Record<string, unknown>): string {
  const error = readText(payload, ['error', 'errorPreview']);
  if (error) return error;
  return readText(payload, ['result', 'content', 'contentPreview']) ?? JSON.stringify(payload);
}

function readText(payload: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    if (typeof payload[key] === 'string' && payload[key]) return payload[key];
  }
  return undefined;
}
