import { getDb } from '@los/infra/db';

import { createTodo } from '../todos.js';
import { linkWorkItemRun } from '../work-items/store.js';
import {
  ensureFeedAnalysisStore,
  linkFeedAnalysisWorkItem,
  type FeedAnalysisDispatchRecord,
} from './feed-analysis-store.js';
import type { FeedAnalysisDeliveryMode, FeedAnalysisStatus } from './feed-analysis-types.js';

export type FeedAnalysisCallbackStatus =
  | 'not_configured'
  | 'pending'
  | 'delivering'
  | 'delivered'
  | 'dead_letter';

export interface FeedAnalysisWorkItemEvidence {
  dispatchId: string;
  sourceSystem: string;
  sourceJobId: string;
  sourceSessionId?: string;
  deliveryMode: FeedAnalysisDeliveryMode;
  dispatchStatus: FeedAnalysisStatus;
  resultAvailable: boolean;
  errorCode?: string;
  errorMessage?: string;
  updatedAt: string;
  callback: {
    configured: boolean;
    latestStatus: FeedAnalysisCallbackStatus;
    latestEventStatus?: string;
    latestSequence?: number;
    eventCount: number;
    pendingCount: number;
    deliveringCount: number;
    deliveredCount: number;
    deadLetterCount: number;
    latestLatencyMs?: number;
    deliveredAt?: string;
    deadLetteredAt?: string;
  };
}

export async function ensureFeedAnalysisWorkItem(
  dispatch: FeedAnalysisDispatchRecord,
): Promise<string> {
  if (dispatch.workItemId) return dispatch.workItemId;
  const workItemId = `todo-feed-analysis-${dispatch.id}`;
  await createTodo({
    id: workItemId,
    tenantId: dispatch.tenantId,
    projectId: dispatch.projectId,
    title: `Feed analysis ${dispatch.sourceSystem} job ${dispatch.sourceJobId}`,
    description: 'Review feed-analysis dispatch, LOS execution, validated result, and callback delivery evidence.',
    kind: 'task',
    status: dispatch.status === 'cancelled' ? 'cancelled' : 'in_progress',
    priority: 'P2',
    source: 'feed-analysis',
    traceId: dispatch.traceId,
    dedupeKey: `feed-analysis-dispatch:${dispatch.id}`,
    taskRunId: dispatch.taskRunId,
    sessionId: dispatch.sessionId,
    runContract: {
      mode: 'feed-analysis-ingress',
      phase: dispatch.status === 'completed' ? 'succeeded' : dispatch.status === 'failed' ? 'blocked' : 'executing',
      goal: 'Review feed-analysis connector execution and result evidence.',
      editableSurfaces: [],
      requiredChecks: [],
      stopConditions: [],
      evidenceRequired: ['feed-analysis dispatch', 'validated result', 'callback delivery'],
      toolMode: 'read-only',
      externalEvidenceAllowed: [],
      rawEvidenceProhibited: [],
    },
    metadata: {
      createdFrom: 'feed-analysis-dispatch',
      feedAnalysis: {
        dispatchId: dispatch.id,
        sourceSystem: dispatch.sourceSystem,
        sourceJobId: dispatch.sourceJobId,
      },
    },
  });
  await linkFeedAnalysisWorkItem(dispatch.id, workItemId);
  if (dispatch.runSpecId || dispatch.taskRunId || dispatch.sessionId) {
    await linkWorkItemRun({
      workItemId,
      runSpecId: dispatch.runSpecId,
      taskRunId: dispatch.taskRunId,
      sessionId: dispatch.sessionId,
      relationKind: 'execution',
    });
  }
  return workItemId;
}

export async function loadFeedAnalysisEvidenceForWorkItem(
  workItemId: string,
): Promise<FeedAnalysisWorkItemEvidence | undefined> {
  await ensureFeedAnalysisStore();
  const dispatches = await getDb().query<DispatchEvidenceRow>(
    `SELECT id, source_system, source_job_id, source_session_id, delivery_mode, status,
       result_available, error_code, error_message, callback_profile_id, updated_at
     FROM feed_analysis_dispatches WHERE work_item_id=$1`,
    [workItemId],
  );
  const dispatch = dispatches.rows[0];
  if (!dispatch) return undefined;
  const callbacks = await getDb().query<CallbackEvidenceRow>(`
    SELECT
      count(e.event_id)::int AS event_count,
      count(*) FILTER (WHERE d.status='pending')::int AS pending_count,
      count(*) FILTER (WHERE d.status='delivering')::int AS delivering_count,
      count(*) FILTER (WHERE d.status='delivered')::int AS delivered_count,
      count(*) FILTER (WHERE d.status='dead_letter')::int AS dead_letter_count,
      (array_agg(e.status ORDER BY e.sequence DESC))[1] AS latest_event_status,
      max(e.sequence)::int AS latest_sequence,
      (array_agg(d.status ORDER BY e.sequence DESC, d.updated_at DESC)
        FILTER (WHERE d.status IS NOT NULL))[1] AS latest_status,
      (array_agg(round(extract(epoch FROM (d.delivered_at-e.created_at))*1000)::int ORDER BY e.sequence DESC)
        FILTER (WHERE d.delivered_at IS NOT NULL))[1] AS latest_latency_ms,
      max(d.delivered_at) AS delivered_at,
      max(d.dead_lettered_at) AS dead_lettered_at
    FROM feed_analysis_callback_events e
    LEFT JOIN feed_analysis_callback_deliveries d ON d.event_id=e.event_id
    WHERE e.dispatch_id=$1
  `, [dispatch.id]);
  const callback = callbacks.rows[0];
  const configured = Boolean(dispatch.callback_profile_id);
  return {
    dispatchId: dispatch.id,
    sourceSystem: dispatch.source_system,
    sourceJobId: dispatch.source_job_id,
    sourceSessionId: dispatch.source_session_id ?? undefined,
    deliveryMode: dispatch.delivery_mode,
    dispatchStatus: dispatch.status,
    resultAvailable: dispatch.result_available,
    errorCode: dispatch.error_code ?? undefined,
    errorMessage: dispatch.error_message ?? undefined,
    updatedAt: toIso(dispatch.updated_at)!,
    callback: {
      configured,
      latestStatus: configured ? callback?.latest_status ?? 'pending' : 'not_configured',
      latestEventStatus: callback?.latest_event_status ?? undefined,
      latestSequence: callback?.latest_sequence ?? undefined,
      eventCount: callback?.event_count ?? 0,
      pendingCount: callback?.pending_count ?? 0,
      deliveringCount: callback?.delivering_count ?? 0,
      deliveredCount: callback?.delivered_count ?? 0,
      deadLetterCount: callback?.dead_letter_count ?? 0,
      latestLatencyMs: callback?.latest_latency_ms ?? undefined,
      deliveredAt: toIso(callback?.delivered_at),
      deadLetteredAt: toIso(callback?.dead_lettered_at),
    },
  };
}

type DispatchEvidenceRow = {
  id: string; source_system: string; source_job_id: string; source_session_id: string | null;
  delivery_mode: FeedAnalysisDeliveryMode; status: FeedAnalysisStatus; result_available: boolean;
  error_code: string | null; error_message: string | null; callback_profile_id: string | null;
  updated_at: Date | string;
};

type CallbackEvidenceRow = {
  event_count: number; pending_count: number; delivering_count: number; delivered_count: number;
  dead_letter_count: number; latest_event_status: string | null; latest_sequence: number | null;
  latest_status: Exclude<FeedAnalysisCallbackStatus, 'not_configured'> | null;
  latest_latency_ms: number | null; delivered_at: Date | string | null; dead_lettered_at: Date | string | null;
};

function toIso(value: Date | string | null | undefined): string | undefined {
  if (!value) return undefined;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
