import { getDb } from '@los/infra/db';
import { ensureSessionEventStore, type SessionEventRecord } from './session-events.js';
import {
  failureFingerprintForToolCall,
  filePathFromToolArgs,
  type PreActionGateConfig,
} from './pre-action-gate.js';

export const _GLOBAL_PRE_ACTION_SESSION_ID = 'los:operator:pre-action-gate';

export interface PreActionEvidenceScope {
  sessionId?: string;
  tenantId?: string;
  projectId?: string;
  limit?: number;
}

export interface PreActionFailureEvidence {
  callId?: string;
  fingerprint: string;
  filePath?: string;
  args: Record<string, unknown>;
  error: string;
}

type EvidenceEvent = Pick<SessionEventRecord, 'type' | 'toolName' | 'payload'>;

const EVIDENCE_EVENT_TYPES = [
  'tool.pre_action.failure',
  'tool.pre_action.fragile_file.added',
  'tool.pre_action.fragile_file.removed',
  'tool.gate.feedback.fail',
] as const;

export function createPreActionFailureEvidence(
  toolName: string,
  args: Record<string, unknown>,
  error: string,
  callId?: string,
): PreActionFailureEvidence {
  return {
    callId,
    fingerprint: failureFingerprintForToolCall(toolName, args),
    filePath: filePathFromToolArgs(args),
    args,
    error,
  };
}

export function _projectPreActionEvidence(events: EvidenceEvent[]): PreActionGateConfig {
  const fragileFiles = new Set<string>();
  const failureFingerprints = new Set<string>();

  for (const event of events) {
    if (event.type === 'tool.pre_action.fragile_file.added') {
      const path = stringField(event.payload.path);
      if (path) fragileFiles.add(path);
      continue;
    }
    if (event.type === 'tool.pre_action.fragile_file.removed') {
      const path = stringField(event.payload.path);
      if (path) fragileFiles.delete(path);
      continue;
    }
    if (event.type !== 'tool.pre_action.failure' && event.type !== 'tool.gate.feedback.fail') {
      continue;
    }

    const args = recordField(event.payload.args);
    const fingerprint = stringField(event.payload.fingerprint)
      ?? (event.toolName ? failureFingerprintForToolCall(event.toolName, args) : undefined);
    const filePath = stringField(event.payload.filePath) ?? filePathFromToolArgs(args);
    if (fingerprint) failureFingerprints.add(fingerprint);
    if (filePath) fragileFiles.add(filePath);
  }

  return { fragileFiles, failureFingerprints };
}

export function mergePreActionEvidence(
  target: PreActionGateConfig,
  source: PreActionGateConfig,
): PreActionGateConfig {
  target.fragileFiles ??= new Set<string>();
  target.failureFingerprints ??= new Set<string>();
  for (const path of source.fragileFiles ?? []) target.fragileFiles.add(path);
  for (const fingerprint of source.failureFingerprints ?? []) {
    target.failureFingerprints.add(fingerprint);
  }
  return target;
}

export async function loadPreActionEvidence(
  scope: PreActionEvidenceScope,
): Promise<PreActionGateConfig> {
  await ensureSessionEventStore();
  const limit = Math.max(1, Math.min(scope.limit ?? 5000, 20_000));
  const rows = await getDb().query<{
    type: string;
    tool_name: string | null;
    payload_json: unknown;
  }>(
    `
      SELECT type, tool_name, payload_json
      FROM (
        SELECT id, type, tool_name, payload_json
        FROM session_events
        WHERE type = ANY($1::text[])
          AND (
            session_id = $2
            OR session_id = $5
            OR ($3::text IS NOT NULL AND project_id = $3
              AND (($4::text IS NULL AND tenant_id IS NULL) OR tenant_id = $4))
          )
        ORDER BY id DESC
        LIMIT $6
      ) recent
      ORDER BY id ASC
    `,
    [
      [...EVIDENCE_EVENT_TYPES],
      scope.sessionId ?? '',
      scope.projectId ?? null,
      scope.tenantId ?? null,
      _GLOBAL_PRE_ACTION_SESSION_ID,
      limit,
    ],
  );

  return _projectPreActionEvidence(rows.rows.map((row) => ({
    type: row.type,
    toolName: row.tool_name ?? undefined,
    payload: recordField(row.payload_json),
  })));
}

function recordField(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stringField(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
