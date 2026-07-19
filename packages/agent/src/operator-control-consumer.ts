import { getDb } from '@los/infra/db';
import type { Message } from './providers/index.js';
import {
  listSessionEventsSince,
  loadSessionEvent,
  notifySessionEvent,
  type SessionEventRecord,
} from './session-events.js';

export type OperatorControlBoundary = 'before_turn' | 'after_completion';

export interface OperatorControlCursors {
  steering: number;
  followup: number;
}

export interface ConsumeOperatorControlInput {
  sessionId?: string;
  runSpecId?: string;
  taskRunId?: string;
  turn: number;
  boundary: OperatorControlBoundary;
  cursors: OperatorControlCursors;
  includeFollowups: boolean;
}

export interface ConsumedOperatorControl {
  source: SessionEventRecord;
  consumption: SessionEventRecord;
  message: Message;
}

export interface ConsumeOperatorControlResult {
  cursors: OperatorControlCursors;
  consumed: ConsumedOperatorControl[];
}

const CONTROL_TYPES = new Set(['operator.steering', 'operator.followup']);

export async function consumeOperatorControlEvents(
  input: ConsumeOperatorControlInput,
): Promise<ConsumeOperatorControlResult> {
  if (!input.sessionId) return { cursors: input.cursors, consumed: [] };

  const nextCursors = { ...input.cursors };
  const sinceId = input.includeFollowups
    ? Math.min(input.cursors.steering, input.cursors.followup)
    : input.cursors.steering;
  const events: SessionEventRecord[] = [];
  let scanSince = sinceId;
  for (;;) {
    const page = await listSessionEventsSince(input.sessionId, scanSince, 200);
    events.push(...page);
    if (page.length < 200) break;
    scanSince = page[page.length - 1]!.id;
  }
  const candidates = events.filter(event => {
    if (!CONTROL_TYPES.has(event.type)) return false;
    if (event.type === 'operator.followup' && !input.includeFollowups) return false;
    if (event.type === 'operator.steering' && event.id <= input.cursors.steering) return false;
    if (event.type === 'operator.followup' && event.id <= input.cursors.followup) return false;
    return matchesTarget(event, input.runSpecId, input.taskRunId);
  });

  const consumed: ConsumedOperatorControl[] = [];
  for (const source of candidates) {
    if (source.type === 'operator.steering') nextCursors.steering = source.id;
    if (source.type === 'operator.followup') nextCursors.followup = source.id;

    const message = controlMessage(source, input.boundary);
    if (!message) continue;
    const consumption = await claimOperatorControl(source, input);
    if (consumption) consumed.push({ source, consumption, message });
  }

  const lastScannedId = events[events.length - 1]?.id;
  if (lastScannedId !== undefined) {
    nextCursors.steering = Math.max(nextCursors.steering, lastScannedId);
    if (input.includeFollowups) {
      nextCursors.followup = Math.max(nextCursors.followup, lastScannedId);
    }
  }

  return { cursors: nextCursors, consumed };
}

async function claimOperatorControl(
  source: SessionEventRecord,
  input: ConsumeOperatorControlInput,
): Promise<SessionEventRecord | null> {
  const consumedAt = new Date().toISOString();
  const rows = await getDb().query<{ id: string }>(
    `
      INSERT INTO session_events (
        session_id, tenant_id, project_id, user_id, node_id, request_id, trace_id,
        turn, type, source, payload_json, parent_event_id, visibility
      )
      SELECT
        event.session_id, event.tenant_id, event.project_id, event.user_id, event.node_id,
        event.request_id, event.trace_id, $3, 'operator.control.consumed', 'los',
        jsonb_build_object(
          'sourceEventId', event.id,
          'controlType', event.type,
          'boundary', $4::text,
          'turn', $3::integer,
          'cursor', event.id,
          'consumerRunSpecId', $5::text,
          'consumerTaskRunId', $6::text,
          'turnBoundary', event.payload_json->'turnBoundary',
          'drainMode', event.payload_json->'drainMode',
          'consumedAt', $7::text
        ),
        event.id,
        'audit'
      FROM session_events event
      WHERE event.session_id = $1
        AND event.id = $2
        AND event.type IN ('operator.steering', 'operator.followup')
        AND (nullif(event.payload_json->>'runSpecId', '') IS NULL OR event.payload_json->>'runSpecId' = $5)
        AND (nullif(event.payload_json->>'taskRunId', '') IS NULL OR event.payload_json->>'taskRunId' = $6)
      ON CONFLICT DO NOTHING
      RETURNING id::text
    `,
    [input.sessionId, source.id, input.turn, input.boundary, input.runSpecId ?? null, input.taskRunId ?? null, consumedAt],
  );
  const id = Number(rows.rows[0]?.id);
  if (!Number.isSafeInteger(id)) return null;
  const consumption = await loadSessionEvent(input.sessionId!, id);
  if (consumption) await notifySessionEvent(consumption);
  return consumption;
}

function matchesTarget(event: SessionEventRecord, runSpecId?: string, taskRunId?: string): boolean {
  const targetRunSpecId = optionalString(event.payload.runSpecId);
  const targetTaskRunId = optionalString(event.payload.taskRunId);
  return (!targetRunSpecId || targetRunSpecId === runSpecId)
    && (!targetTaskRunId || targetTaskRunId === taskRunId);
}

function controlMessage(event: SessionEventRecord, boundary: OperatorControlBoundary): Message | null {
  if (event.type === 'operator.steering') {
    const instruction = optionalString(event.payload.instruction);
    if (!instruction) return null;
    const requestedBoundary = optionalString(event.payload.turnBoundary) ?? 'next_turn';
    const drainMode = optionalString(event.payload.drainMode) ?? 'finish_current_turn';
    return {
      role: 'user',
      content: `[Operator steering #${event.id}; requested=${requestedBoundary}; drain=${drainMode}; applied=${boundary}]\n${instruction}`,
    };
  }

  const prompt = optionalString(event.payload.prompt);
  if (!prompt) return null;
  return {
    role: 'user',
    content: `[Operator follow-up #${event.id}; applied after the current work completed]\n${prompt}`,
  };
}

function optionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}
