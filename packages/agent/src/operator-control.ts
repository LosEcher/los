import { appendSessionEvent, ensureSessionEventStore, type SessionEventRecord } from './session-events.js';
import type { DbTransactionClient } from '@los/infra/db';

export interface RecordOperatorSteeringInput extends OperatorEventContext {
  instruction: string;
  turnBoundary?: 'next_turn' | 'immediate';
  drainMode?: 'none' | 'finish_current_tool' | 'finish_current_turn';
}

export interface RecordOperatorFollowupInput extends OperatorEventContext {
  prompt: string;
  parentSessionId?: string;
}

export interface RecordSessionBranchCreatedInput extends OperatorEventContext {
  parentSessionId: string;
  branchAtTurn?: number;
  copiedMessageCount?: number;
  parentMessageCount?: number;
  parentTurnCount?: number;
}

interface OperatorEventContext {
  sessionId: string;
  runSpecId?: string;
  taskRunId?: string;
  tenantId?: string;
  projectId?: string;
  userId?: string;
  nodeId?: string;
  requestId?: string;
  traceId?: string;
  actor?: string;
  reason?: string;
}

export async function recordOperatorSteering(
  input: RecordOperatorSteeringInput,
  options?: OperatorEventWriteOptions,
): Promise<SessionEventRecord> {
  const instruction = requiredString(input.instruction, 'instruction');
  return await appendOperatorEvent(input, 'operator.steering', {
    instruction,
    turnBoundary: input.turnBoundary ?? 'next_turn',
    drainMode: input.drainMode ?? 'finish_current_turn',
  }, options);
}

export async function recordOperatorFollowup(
  input: RecordOperatorFollowupInput,
  options?: OperatorEventWriteOptions,
): Promise<SessionEventRecord> {
  const prompt = requiredString(input.prompt, 'prompt');
  return await appendOperatorEvent(input, 'operator.followup', {
    prompt,
    parentSessionId: optionalString(input.parentSessionId) ?? null,
  }, options);
}

interface OperatorEventWriteOptions {
  client?: DbTransactionClient;
  notify?: boolean;
}

export async function recordSessionBranchCreated(input: RecordSessionBranchCreatedInput): Promise<SessionEventRecord> {
  const parentSessionId = requiredString(input.parentSessionId, 'parentSessionId');
  return await appendOperatorEvent(input, 'session.branch_created', {
    parentSessionId,
    branchAtTurn: positiveInteger(input.branchAtTurn) ?? null,
    copiedMessageCount: positiveInteger(input.copiedMessageCount) ?? null,
    parentMessageCount: positiveInteger(input.parentMessageCount) ?? null,
    parentTurnCount: positiveInteger(input.parentTurnCount) ?? null,
  });
}

async function appendOperatorEvent(
  context: OperatorEventContext,
  type: 'operator.steering' | 'operator.followup' | 'session.branch_created',
  payload: Record<string, unknown>,
  options?: OperatorEventWriteOptions,
): Promise<SessionEventRecord> {
  await ensureSessionEventStore();
  return await appendSessionEvent({
    sessionId: requiredString(context.sessionId, 'sessionId'),
    tenantId: optionalString(context.tenantId),
    projectId: optionalString(context.projectId),
    userId: optionalString(context.userId),
    nodeId: optionalString(context.nodeId),
    requestId: optionalString(context.requestId),
    traceId: optionalString(context.traceId),
    type,
    source: 'operator',
    visibility: 'audit',
    payload: {
      ...payload,
      runSpecId: optionalString(context.runSpecId) ?? null,
      taskRunId: optionalString(context.taskRunId) ?? null,
      actor: optionalString(context.actor) ?? null,
      reason: optionalString(context.reason) ?? null,
      recordedAt: new Date().toISOString(),
    },
  }, options);
}

function requiredString(value: unknown, name: string): string {
  const normalized = optionalString(value);
  if (!normalized) throw new Error(`${name} is required`);
  return normalized;
}

function optionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function positiveInteger(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  const int = Math.floor(value);
  return int > 0 ? int : undefined;
}
