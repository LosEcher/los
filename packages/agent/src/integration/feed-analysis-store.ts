import { createHash, randomUUID } from 'node:crypto';
import { getDb, withDbClient, type DbTransactionClient } from '@los/infra/db';
import {
  _FEED_ANALYSIS_RESULT_VERSION,
  type FeedAnalysisArtifact,
  type FeedAnalysisDeliveryMode,
  type FeedAnalysisResultEnvelope,
  type FeedAnalysisStatus,
  FeedAnalysisError,
} from './feed-analysis-types.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS feed_analysis_dispatches (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL DEFAULT 'local', project_id TEXT NOT NULL DEFAULT 'los',
  source_system TEXT NOT NULL, source_job_id TEXT NOT NULL, source_session_id TEXT,
  delivery_mode TEXT NOT NULL, contract_version TEXT NOT NULL, bundle_version TEXT, bundle_id TEXT,
  input_digest TEXT NOT NULL, idempotency_key TEXT NOT NULL,
  requested_outputs_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  policy_json JSONB NOT NULL DEFAULT '{}'::jsonb, callback_profile_id TEXT, material_json JSONB,
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb, run_spec_id TEXT, task_run_id TEXT,
  session_id TEXT, trace_id TEXT, status TEXT NOT NULL DEFAULT 'accepted',
  result_available BOOLEAN NOT NULL DEFAULT false, error_code TEXT, error_message TEXT,
  sequence INTEGER NOT NULL DEFAULT 0, retention_expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  UNIQUE (tenant_id, project_id, source_system, source_job_id), CHECK (delivery_mode IN ('delivery_only','result_returning')), CHECK (status IN ('accepted','queued','processing','result_ready','completed','failed','cancelled'))
);
CREATE INDEX IF NOT EXISTS idx_feed_analysis_dispatch_status ON feed_analysis_dispatches(status, updated_at);
CREATE INDEX IF NOT EXISTS idx_feed_analysis_dispatch_run ON feed_analysis_dispatches(run_spec_id);
CREATE TABLE IF NOT EXISTS feed_analysis_results (
  dispatch_id TEXT PRIMARY KEY REFERENCES feed_analysis_dispatches(id) ON DELETE CASCADE,
  schema_version TEXT NOT NULL, summary TEXT NOT NULL,
  citations_json JSONB NOT NULL DEFAULT '[]'::jsonb, warnings_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  workflow_id TEXT NOT NULL, workflow_version TEXT NOT NULL, prompt_id TEXT NOT NULL, prompt_version TEXT NOT NULL,
  provider TEXT, model TEXT, usage_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  result_json JSONB NOT NULL, result_digest TEXT NOT NULL,
  validated_at TIMESTAMPTZ NOT NULL DEFAULT now(), created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS feed_analysis_artifacts (
  artifact_id TEXT PRIMARY KEY, dispatch_id TEXT NOT NULL REFERENCES feed_analysis_dispatches(id) ON DELETE CASCADE,
  artifact_kind TEXT NOT NULL, target_platform TEXT, locale TEXT NOT NULL, title TEXT,
  title_candidates_json JSONB NOT NULL DEFAULT '[]'::jsonb, body TEXT NOT NULL,
  hashtags_json JSONB NOT NULL DEFAULT '[]'::jsonb, structured_payload_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  citation_refs_json JSONB NOT NULL DEFAULT '[]'::jsonb, workflow_id TEXT NOT NULL, workflow_version TEXT NOT NULL,
  prompt_id TEXT NOT NULL, prompt_version TEXT NOT NULL, review_status TEXT NOT NULL DEFAULT 'draft',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_feed_analysis_artifact_dispatch ON feed_analysis_artifacts(dispatch_id, created_at);
CREATE TABLE IF NOT EXISTS feed_analysis_callback_events (
  event_id TEXT PRIMARY KEY, dispatch_id TEXT NOT NULL REFERENCES feed_analysis_dispatches(id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL, event_version TEXT NOT NULL, status TEXT NOT NULL,
  payload_json JSONB NOT NULL, payload_digest TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (dispatch_id, sequence)
);
CREATE TABLE IF NOT EXISTS feed_analysis_callback_deliveries (
  id TEXT PRIMARY KEY, event_id TEXT NOT NULL REFERENCES feed_analysis_callback_events(event_id) ON DELETE CASCADE,
  profile_id TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', attempt_count INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(), lease_owner TEXT, lease_expires_at TIMESTAMPTZ,
  last_http_status INTEGER, last_error TEXT, delivered_at TIMESTAMPTZ, dead_lettered_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (event_id, profile_id), CHECK (status IN ('pending', 'delivering', 'delivered', 'dead_letter'))
);
CREATE INDEX IF NOT EXISTS idx_feed_analysis_callback_due ON feed_analysis_callback_deliveries(next_attempt_at, created_at) WHERE status = 'pending';
`;

export interface FeedAnalysisDispatchRecord {
  id: string;
  tenantId: string;
  projectId: string;
  sourceSystem: string;
  sourceJobId: string;
  sourceSessionId?: string;
  deliveryMode: FeedAnalysisDeliveryMode;
  inputDigest: string;
  idempotencyKey: string;
  requestedOutputs: string[];
  policy: Record<string, unknown>;
  callbackProfileId?: string;
  material?: Record<string, unknown>;
  metadata: Record<string, unknown>;
  runSpecId?: string;
  taskRunId?: string;
  sessionId?: string;
  traceId?: string;
  status: FeedAnalysisStatus;
  resultAvailable: boolean;
  errorCode?: string;
  errorMessage?: string;
  sequence: number;
  createdAt: string;
  updatedAt: string;
}

export interface CreateFeedAnalysisDispatchInput {
  id: string;
  tenantId: string;
  projectId: string;
  sourceSystem: string;
  sourceJobId: string;
  sourceSessionId?: string;
  deliveryMode: FeedAnalysisDeliveryMode;
  contractVersion: string;
  bundleVersion?: string;
  bundleId?: string;
  inputDigest: string;
  idempotencyKey: string;
  requestedOutputs: string[];
  policy: Record<string, unknown>;
  callbackProfileId?: string;
  material?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  retentionExpiresAt?: string;
}

let initialized = false;

export async function ensureFeedAnalysisStore(): Promise<void> {
  if (initialized) return;
  await getDb().exec(SCHEMA);
  initialized = true;
}

export async function createOrLoadFeedAnalysisDispatch(
  input: CreateFeedAnalysisDispatchInput,
): Promise<{ record: FeedAnalysisDispatchRecord; deduplicated: boolean }> {
  await ensureFeedAnalysisStore();
  return await withDbClient(async (client) => {
    await client.query('BEGIN');
    try {
      const inserted = await client.query<FeedAnalysisDispatchRow>(`
        INSERT INTO feed_analysis_dispatches (
          id, tenant_id, project_id, source_system, source_job_id, source_session_id,
          delivery_mode, contract_version, bundle_version, bundle_id, input_digest, idempotency_key,
          requested_outputs_json, policy_json, callback_profile_id, material_json, metadata_json,
          retention_expires_at, status, updated_at
        ) VALUES (
          $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14::jsonb,$15,$16::jsonb,$17::jsonb,$18,'accepted',now()
        ) ON CONFLICT DO NOTHING RETURNING *
      `, [
        input.id, input.tenantId, input.projectId, input.sourceSystem, input.sourceJobId,
        input.sourceSessionId ?? null, input.deliveryMode, input.contractVersion,
        input.bundleVersion ?? null, input.bundleId ?? null, input.inputDigest, input.idempotencyKey,
        JSON.stringify(input.requestedOutputs), JSON.stringify(input.policy), input.callbackProfileId ?? null,
        input.material ? JSON.stringify(input.material) : null, JSON.stringify(input.metadata ?? {}),
        input.retentionExpiresAt ?? null,
      ]);
      if (inserted.rows[0]) {
        await _insertFeedAnalysisCallbackEvent(client, inserted.rows[0], 'accepted');
        await client.query('COMMIT');
        return { record: rowToDispatch(inserted.rows[0]), deduplicated: false };
      }

      const existing = await client.query<FeedAnalysisDispatchRow>(`
        SELECT * FROM feed_analysis_dispatches
        WHERE tenant_id=$1 AND project_id=$2 AND source_system=$3 AND source_job_id=$4
        FOR UPDATE
      `, [input.tenantId, input.projectId, input.sourceSystem, input.sourceJobId]);
      const row = existing.rows[0];
      if (!row) throw new Error('feed-analysis dispatch conflict without existing row');
      if (row.input_digest !== input.inputDigest) {
        throw new FeedAnalysisError('source_job_conflict', 'source job already exists with a different input digest', 409);
      }
      await client.query('COMMIT');
      return { record: rowToDispatch(row), deduplicated: true };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  });
}
export async function loadFeedAnalysisDispatch(id: string): Promise<FeedAnalysisDispatchRecord | null> {
  await ensureFeedAnalysisStore();
  const result = await getDb().query<FeedAnalysisDispatchRow>('SELECT * FROM feed_analysis_dispatches WHERE id=$1', [id]);
  return result.rows[0] ? rowToDispatch(result.rows[0]) : null;
}

export async function linkFeedAnalysisExecution(input: {
  dispatchId: string; runSpecId: string; sessionId: string; traceId: string; taskRunId?: string;
}): Promise<void> {
  await ensureFeedAnalysisStore();
  await getDb().query(`
    UPDATE feed_analysis_dispatches SET run_spec_id=$2, session_id=$3, trace_id=$4,
      task_run_id=COALESCE($5, task_run_id), status='queued', updated_at=now()
    WHERE id=$1
  `, [input.dispatchId, input.runSpecId, input.sessionId, input.traceId, input.taskRunId ?? null]);
  await emitFeedAnalysisStatus(input.dispatchId, 'queued');
}

export async function updateFeedAnalysisTaskRun(dispatchId: string, taskRunId: string): Promise<void> {
  await ensureFeedAnalysisStore();
  await getDb().query('UPDATE feed_analysis_dispatches SET task_run_id=$2, updated_at=now() WHERE id=$1', [dispatchId, taskRunId]);
}

export async function emitFeedAnalysisStatus(
  dispatchId: string,
  status: FeedAnalysisStatus,
  error?: { code: string; message: string },
): Promise<FeedAnalysisDispatchRecord> {
  await ensureFeedAnalysisStore();
  return await withDbClient(async (client) => {
    await client.query('BEGIN');
    try {
      const selected = await client.query<FeedAnalysisDispatchRow>(
        'SELECT * FROM feed_analysis_dispatches WHERE id=$1 FOR UPDATE', [dispatchId],
      );
      const current = selected.rows[0];
      if (!current) throw new FeedAnalysisError('dispatch_not_found', 'dispatch not found', 404);
      assertStatusTransition(current.status as FeedAnalysisStatus, status);
      const updated = await client.query<FeedAnalysisDispatchRow>(`
        UPDATE feed_analysis_dispatches SET status=$2, error_code=$3, error_message=$4,
          completed_at=CASE WHEN $2 IN ('completed','failed','cancelled') THEN now() ELSE completed_at END,
          updated_at=now() WHERE id=$1 RETURNING *
      `, [dispatchId, status, error?.code ?? null, error?.message ?? null]);
      const row = updated.rows[0]!;
      await _insertFeedAnalysisCallbackEvent(client, row, status, error);
      await client.query('COMMIT');
      return rowToDispatch(row);
    } catch (cause) {
      await client.query('ROLLBACK');
      throw cause;
    }
  });
}

export async function saveFeedAnalysisResult(
  dispatchId: string,
  result: FeedAnalysisResultEnvelope,
): Promise<FeedAnalysisResultEnvelope> {
  await ensureFeedAnalysisStore();
  const digest = digestJson({ ...result, resultDigest: undefined });
  const persisted = { ...result, schemaVersion: _FEED_ANALYSIS_RESULT_VERSION, resultDigest: digest } as FeedAnalysisResultEnvelope;
  await withDbClient(async (client) => {
    await client.query('BEGIN');
    try {
      const selected = await client.query<FeedAnalysisDispatchRow>('SELECT * FROM feed_analysis_dispatches WHERE id=$1 FOR UPDATE', [dispatchId]);
      const current = selected.rows[0];
      if (!current) throw new FeedAnalysisError('dispatch_not_found', 'dispatch not found', 404);
      assertStatusTransition(current.status, 'completed');
      await client.query(`
        INSERT INTO feed_analysis_results (
          dispatch_id, schema_version, summary, citations_json, warnings_json, workflow_id, workflow_version,
          prompt_id, prompt_version, provider, model, usage_json, result_json, result_digest
        ) VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,$6,$7,$8,$9,$10,$11,$12::jsonb,$13::jsonb,$14)
        ON CONFLICT (dispatch_id) DO UPDATE SET summary=EXCLUDED.summary, citations_json=EXCLUDED.citations_json,
          warnings_json=EXCLUDED.warnings_json, workflow_id=EXCLUDED.workflow_id, workflow_version=EXCLUDED.workflow_version,
          prompt_id=EXCLUDED.prompt_id, prompt_version=EXCLUDED.prompt_version, provider=EXCLUDED.provider,
          model=EXCLUDED.model, usage_json=EXCLUDED.usage_json, result_json=EXCLUDED.result_json,
          result_digest=EXCLUDED.result_digest, validated_at=now()
      `, [
        dispatchId, persisted.schemaVersion, persisted.summary, JSON.stringify(persisted.citations),
        JSON.stringify(persisted.warnings), persisted.workflow.id, persisted.workflow.version,
        persisted.prompt.id, persisted.prompt.version, persisted.provider?.name ?? null,
        persisted.provider?.model ?? null, JSON.stringify(persisted.usage ?? {}), JSON.stringify(persisted), digest,
      ]);
      await client.query('DELETE FROM feed_analysis_artifacts WHERE dispatch_id=$1', [dispatchId]);
      for (const artifact of persisted.artifacts) await insertArtifact(client, dispatchId, artifact);
      const updated = await client.query<FeedAnalysisDispatchRow>(`
        UPDATE feed_analysis_dispatches SET status='completed', result_available=true,
          error_code=NULL, error_message=NULL, completed_at=now(), updated_at=now()
        WHERE id=$1 RETURNING *
      `, [dispatchId]);
      await _insertFeedAnalysisCallbackEvent(client, updated.rows[0]!, 'completed', undefined, persisted);
      await client.query('COMMIT');
    } catch (cause) {
      await client.query('ROLLBACK');
      throw cause;
    }
  });
  return persisted;
}
export async function loadFeedAnalysisResult(dispatchId: string): Promise<FeedAnalysisResultEnvelope | null> {
  await ensureFeedAnalysisStore();
  const rows = await getDb().query<{ result_json: unknown }>('SELECT result_json FROM feed_analysis_results WHERE dispatch_id=$1', [dispatchId]);
  return rows.rows[0]?.result_json as FeedAnalysisResultEnvelope | undefined ?? null;
}

export async function pruneExpiredFeedAnalysisMaterial(limit = 100): Promise<number> {
  await ensureFeedAnalysisStore();
  const rows = await getDb().query<{ id: string }>(`WITH expired AS (
      SELECT id FROM feed_analysis_dispatches
      WHERE material_json IS NOT NULL AND retention_expires_at IS NOT NULL AND retention_expires_at <= now()
      ORDER BY retention_expires_at
      LIMIT $1
      FOR UPDATE SKIP LOCKED
    )
    UPDATE feed_analysis_dispatches d
    SET material_json=NULL, updated_at=now(),
      metadata_json=d.metadata_json || '{"materialPruned":true}'::jsonb
    FROM expired WHERE d.id=expired.id
    RETURNING d.id`, [Math.max(1, Math.min(1000, Math.floor(limit)))]);
  return rows.rows.length;
}

async function insertArtifact(client: DbTransactionClient, dispatchId: string, artifact: FeedAnalysisArtifact): Promise<void> {
  await client.query(`
    INSERT INTO feed_analysis_artifacts (
      artifact_id, dispatch_id, artifact_kind, target_platform, locale, title, title_candidates_json,
      body, hashtags_json, structured_payload_json, citation_refs_json, workflow_id, workflow_version,
      prompt_id, prompt_version, review_status, updated_at
    ) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9::jsonb,$10::jsonb,$11::jsonb,$12,$13,$14,$15,$16,now())
  `, [
    artifact.artifactId, dispatchId, artifact.kind, artifact.platform ?? null, artifact.locale,
    artifact.title ?? null, JSON.stringify(artifact.titleCandidates), artifact.body,
    JSON.stringify(artifact.hashtags), JSON.stringify(artifact.structuredPayload), JSON.stringify(artifact.citationRefs),
    artifact.workflowId, artifact.workflowVersion, artifact.promptId, artifact.promptVersion, artifact.reviewStatus,
  ]);
}

export async function _insertFeedAnalysisCallbackEvent(
  client: DbTransactionClient,
  row: FeedAnalysisDispatchRow,
  status: FeedAnalysisStatus | 'progress',
  error?: { code: string; message: string },
  result?: FeedAnalysisResultEnvelope,
  progress?: { stage: string; title?: string; taskRunId?: string },
): Promise<void> {
  if (!row.callback_profile_id) return;
  const sequence = Number(row.sequence) + 1;
  const eventId = `faevt-${randomUUID()}`;
  const payload = {
    eventId, eventVersion: _FEED_ANALYSIS_RESULT_VERSION, sourceJobId: row.source_job_id,
    dispatchId: row.id, sequence, status, result, error, progress, occurredAt: new Date().toISOString(),
  };
  await client.query('UPDATE feed_analysis_dispatches SET sequence=$2 WHERE id=$1', [row.id, sequence]);
  await client.query(`
    INSERT INTO feed_analysis_callback_events (event_id, dispatch_id, sequence, event_version, status, payload_json, payload_digest)
    VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7)
  `, [eventId, row.id, sequence, _FEED_ANALYSIS_RESULT_VERSION, status, JSON.stringify(payload), digestJson(payload)]);
  await client.query(`
    INSERT INTO feed_analysis_callback_deliveries (id, event_id, profile_id)
    VALUES ($1,$2,$3) ON CONFLICT DO NOTHING
  `, [`fadel-${randomUUID()}`, eventId, row.callback_profile_id]);
}

const STATUS_TRANSITIONS: Record<FeedAnalysisStatus, ReadonlySet<FeedAnalysisStatus>> = {
  accepted: new Set(['accepted', 'queued', 'processing', 'failed', 'cancelled']),
  queued: new Set(['queued', 'processing', 'failed', 'cancelled']),
  processing: new Set(['processing', 'result_ready', 'completed', 'failed', 'cancelled']),
  result_ready: new Set(['result_ready', 'completed', 'failed', 'cancelled']),
  completed: new Set(['completed']), failed: new Set(['failed']), cancelled: new Set(['cancelled']),
};

function assertStatusTransition(from: FeedAnalysisStatus, to: FeedAnalysisStatus): void {
  if (!STATUS_TRANSITIONS[from]?.has(to)) {
    throw new FeedAnalysisError('invalid_state', `cannot transition feed-analysis dispatch from ${from} to ${to}`, 409);
  }
}

export function digestJson(value: unknown): string {
  return createHash('sha256').update(stableStringify(value)).digest('hex');
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(',')}}`;
}

export type FeedAnalysisDispatchRow = {
  id: string; tenant_id: string; project_id: string; source_system: string; source_job_id: string;
  source_session_id: string | null; delivery_mode: FeedAnalysisDeliveryMode; input_digest: string;
  idempotency_key: string; requested_outputs_json: unknown; policy_json: unknown; callback_profile_id: string | null;
  material_json: unknown; metadata_json: unknown; run_spec_id: string | null; task_run_id: string | null;
  session_id: string | null; trace_id: string | null; status: FeedAnalysisStatus; result_available: boolean;
  error_code: string | null; error_message: string | null; sequence: number | string;
  created_at: Date | string; updated_at: Date | string;
};

function rowToDispatch(row: FeedAnalysisDispatchRow): FeedAnalysisDispatchRecord {
  return {
    id: row.id, tenantId: row.tenant_id, projectId: row.project_id, sourceSystem: row.source_system,
    sourceJobId: row.source_job_id, sourceSessionId: row.source_session_id ?? undefined,
    deliveryMode: row.delivery_mode, inputDigest: row.input_digest, idempotencyKey: row.idempotency_key,
    requestedOutputs: readStringArray(row.requested_outputs_json), policy: readObject(row.policy_json),
    callbackProfileId: row.callback_profile_id ?? undefined, material: readOptionalObject(row.material_json),
    metadata: readObject(row.metadata_json), runSpecId: row.run_spec_id ?? undefined,
    taskRunId: row.task_run_id ?? undefined, sessionId: row.session_id ?? undefined, traceId: row.trace_id ?? undefined,
    status: row.status, resultAvailable: row.result_available, errorCode: row.error_code ?? undefined,
    errorMessage: row.error_message ?? undefined, sequence: Number(row.sequence),
    createdAt: toIso(row.created_at), updatedAt: toIso(row.updated_at),
  };
}

function readObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function readOptionalObject(value: unknown): Record<string, unknown> | undefined {
  const object = readObject(value);
  return Object.keys(object).length > 0 ? object : undefined;
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
