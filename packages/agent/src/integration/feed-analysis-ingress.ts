import { randomUUID } from 'node:crypto';
import { createRunSpec } from '../run-specs.js';
import { appendSessionEvent } from '../session-events.js';
import { loadTaskRun } from '../task-runs.js';
import { transitionExecutionState } from '../execution-store.js';
import { cancelScheduledTask } from '../scheduler.js';
import { requestCancellation } from '../cancellation.js';
import {
  _FEED_ANALYSIS_CONTRACT_VERSION,
  type FeedAnalysisDeliveryMode,
  type FeedAnalysisDispatchRequest,
  type FeedAnalysisDispatchResult,
  type FeedAnalysisDispatchState,
  type FeedAnalysisResultResponse,
  type FeedAnalysisStatus,
  type FeedAnalysisTarget,
  FeedAnalysisError,
} from './feed-analysis-types.js';
import {
  createOrLoadFeedAnalysisDispatch,
  emitFeedAnalysisStatus,
  linkFeedAnalysisExecution,
  loadFeedAnalysisDispatch,
  loadFeedAnalysisResult,
  type FeedAnalysisDispatchRecord,
} from './feed-analysis-store.js';
import {
  buildFeedAnalysisWorkflowPrompt,
  prepareFeedAnalysisInput,
  type FeedAnalysisWorkflowLimits,
} from './feed-analysis-workflow.js';
import { _executeFeedAnalysisDispatch } from './feed-analysis-execution.js';
import { ensureFeedAnalysisWorkItem } from './feed-analysis-work-item.js';

export interface FeedAnalysisDispatchOptions extends FeedAnalysisWorkflowLimits {
  workspaceRoot: string;
  tenantId?: string;
  projectId?: string;
  userId?: string;
  requestId?: string;
  provider?: string;
  model?: string;
  timeoutMs?: number;
}

export interface FeedAnalysisCapabilityOptions {
  callbackEnabled?: boolean;
  resultReturningEnabled?: boolean;
  maxInlineBytes?: number;
  maxItems?: number;
}

const DEFAULT_LIMITS: FeedAnalysisWorkflowLimits = {
  maxInlineBytes: 1024 * 1024,
  maxItems: 500,
  materialHosts: [],
  materialFetchTimeoutMs: 10_000,
};

export function listFeedAnalysisTargets(options: FeedAnalysisCapabilityOptions = {}): { targets: FeedAnalysisTarget[] } {
  const supportsResultReturning = options.resultReturningEnabled !== false;
  const deliveryModes: FeedAnalysisDeliveryMode[] = supportsResultReturning
    ? ['delivery_only', 'result_returning']
    : ['delivery_only'];
  return {
    targets: [{
      kind: 'los-ingress',
      label: 'los Agent Execution Platform',
      contractVersions: [_FEED_ANALYSIS_CONTRACT_VERSION],
      supportedDeliveryModes: deliveryModes,
      supportedOutputs: ['daily_digest', 'content_brief', 'platform_draft'],
      supportedScenarios: ['evidence_batch', 'research_topic'],
      supportedWorkflowProfiles: ['batch_summary', 'daily_content', 'research_deep'],
      supportedPlatforms: ['xiaohongshu', 'zhihu', 'weibo', 'x'],
      supportedLocales: ['zh-CN'],
      supportsResultReturning,
      supportsCallback: options.callbackEnabled === true,
      supportsCancellation: true,
      maxInlineBytes: options.maxInlineBytes ?? DEFAULT_LIMITS.maxInlineBytes,
      maxItems: options.maxItems ?? DEFAULT_LIMITS.maxItems,
      status: 'available',
    }],
  };
}

export async function dispatchFeedAnalysisJob(
  request: FeedAnalysisDispatchRequest,
  idempotencyKey: string,
  options: FeedAnalysisDispatchOptions,
): Promise<FeedAnalysisDispatchResult> {
  const deliveryMode = normalizeDeliveryMode(request.deliveryMode);
  const sourceSystem = requireString(request.sourceSystem, 'sourceSystem');
  const sourceJobId = requireString(request.sourceJobId, 'sourceJobId');
  const prepared = await prepareFeedAnalysisInput({ ...request, sourceSystem, sourceJobId, deliveryMode }, options);
  const candidateDispatchId = `fa-${randomUUID()}`;
  const tenantId = options.tenantId ?? 'local';
  const projectId = options.projectId ?? 'los';
  const retentionDays = typeof prepared.policy.retentionDays === 'number' ? prepared.policy.retentionDays : 30;
  const created = await createOrLoadFeedAnalysisDispatch({
    id: candidateDispatchId,
    tenantId,
    projectId,
    sourceSystem,
    sourceJobId,
    sourceSessionId: request.sourceSessionId,
    deliveryMode,
    contractVersion: _FEED_ANALYSIS_CONTRACT_VERSION,
    bundleVersion: prepared.materialBundle.schemaVersion,
    bundleId: prepared.materialBundle.bundleId,
    inputDigest: prepared.inputDigest,
    idempotencyKey,
    requestedOutputs: prepared.requestedOutputs,
    policy: prepared.policy,
    callbackProfileId: normalizeOptionalString(request.callback?.profileId),
    material: prepared.materialBundle as unknown as Record<string, unknown>,
    metadata: {
      ...request.metadata,
      scenario: prepared.workflow.scenario,
      workflowProfile: prepared.workflow.profile,
      collectionSnapshotId: prepared.collectionSnapshot?.snapshotId,
      topicId: prepared.topic?.topicId,
    },
    retentionExpiresAt: new Date(Date.now() + retentionDays * 86_400_000).toISOString(),
  });

  if (created.deduplicated && created.record.runSpecId) {
    const workItemId = await ensureFeedAnalysisWorkItem(created.record);
    return dispatchToResult({ ...created.record, workItemId }, true, request.threadId);
  }
  const dispatchId = created.record.id;

  const traceId = randomUUID();
  const sessionId = request.sessionId ?? request.sourceSessionId ?? `fa-session-${randomUUID()}`;
  const prompt = buildFeedAnalysisWorkflowPrompt(prepared);
  const runSpec = await createRunSpec({
    id: dispatchId,
    sessionId,
    tenantId,
    projectId,
    userId: options.userId,
    requestId: options.requestId,
    traceId,
    provider: options.provider,
    model: options.model,
    prompt,
    workspaceRoot: options.workspaceRoot,
    toolMode: 'read-only',
    maxLoops: prepared.workflow.maxLoops,
    timeoutMs: options.timeoutMs,
    runContract: {
      mode: 'feed-analysis-ingress',
      executionMode: prepared.workflow.executionMode,
      goal: JSON.stringify({
        sourceSystem,
        sourceJobId,
        deliveryMode,
        scenario: prepared.workflow.scenario,
        workflow: `${prepared.workflow.workflowId}@${prepared.workflow.workflowVersion}`,
      }),
      selfCheckEnabled: false,
    },
    modelSettings: {},
  });

  await linkFeedAnalysisExecution({ dispatchId, runSpecId: runSpec.id, sessionId, traceId });
  const linkedForWorkItem = await loadFeedAnalysisDispatch(dispatchId);
  if (!linkedForWorkItem) throw new Error(`feed-analysis dispatch disappeared: ${dispatchId}`);
  const workItemId = await ensureFeedAnalysisWorkItem(linkedForWorkItem);
  await appendSessionEvent({
    sessionId,
    tenantId,
    projectId,
    userId: options.userId,
    requestId: options.requestId,
    traceId,
    type: 'feed_analysis.dispatch_received',
    payload: {
      event: 'feed_analysis.dispatch_received', dispatchId, sourceSystem, sourceJobId, deliveryMode,
      bundleId: prepared.materialBundle.bundleId, inputDigest: prepared.inputDigest,
      itemCount: prepared.materialBundle.items.length, requestedOutputs: prepared.requestedOutputs,
      scenario: prepared.workflow.scenario, workflowProfile: prepared.workflow.profile,
      collectionSnapshotId: prepared.collectionSnapshot?.snapshotId, topicId: prepared.topic?.topicId,
    },
  });

  void _executeFeedAnalysisDispatch({
    dispatchId,
    prompt,
    sessionId,
    traceId,
    workspaceRoot: options.workspaceRoot,
    tenantId,
    projectId,
    userId: options.userId,
    requestId: options.requestId,
    provider: options.provider,
    model: options.model,
    timeoutMs: options.timeoutMs,
    deliveryMode,
    prepared,
  });

  const linked = await loadFeedAnalysisDispatch(dispatchId);
  if (!linked) throw new Error(`feed-analysis dispatch disappeared: ${dispatchId}`);
  return dispatchToResult({ ...linked, workItemId }, false, request.threadId);
}

export async function getFeedAnalysisDispatch(dispatchId: string): Promise<FeedAnalysisDispatchResult | null> {
  const record = await loadFeedAnalysisDispatch(dispatchId);
  return record ? dispatchToResult(record, false) : null;
}

export async function getFeedAnalysisResult(dispatchId: string): Promise<FeedAnalysisResultResponse | null> {
  const dispatch = await loadFeedAnalysisDispatch(dispatchId);
  if (!dispatch) return null;
  const result = dispatch.resultAvailable ? await loadFeedAnalysisResult(dispatchId) : null;
  return {
    dispatchId,
    status: dispatch.status,
    resultAvailable: Boolean(result),
    result: result ?? undefined,
    error: dispatch.errorCode ? { code: dispatch.errorCode, message: dispatch.errorMessage ?? dispatch.errorCode } : undefined,
  };
}

export async function cancelFeedAnalysisDispatch(
  dispatchId: string,
  reason = 'cancelled_by_integration',
): Promise<{ dispatchId: string; status: FeedAnalysisStatus; cancelled: boolean }> {
  const dispatch = await loadFeedAnalysisDispatch(dispatchId);
  if (!dispatch) throw new FeedAnalysisError('dispatch_not_found', 'dispatch not found', 404);
  if (dispatch.status === 'cancelled') return { dispatchId, status: 'cancelled', cancelled: true };
  if (dispatch.status === 'completed' || dispatch.status === 'failed') {
    throw new FeedAnalysisError('invalid_state', `cannot cancel ${dispatch.status} dispatch`, 409);
  }

  if (dispatch.taskRunId) {
    const taskRun = await loadTaskRun(dispatch.taskRunId);
    if (taskRun && (taskRun.status === 'queued' || taskRun.status === 'running')) {
      cancelScheduledTask(taskRun.id, reason);
      await requestCancellation(taskRun.id, reason, 'feed-analysis').catch(() => undefined);
      await transitionExecutionState({
        entityType: 'task_run', entityId: taskRun.id, to: 'cancelled', sessionId: taskRun.sessionId, reason,
      }).catch(() => undefined);
    }
  }
  const cancelled = await emitFeedAnalysisStatus(dispatchId, 'cancelled');
  return { dispatchId, status: cancelled.status, cancelled: true };
}

function dispatchToResult(
  record: FeedAnalysisDispatchRecord,
  deduplicated: boolean,
  threadId?: string,
): FeedAnalysisDispatchResult {
  return {
    dispatch: {
      id: record.id,
      status: record.status,
      workItemId: record.workItemId,
      runId: record.runSpecId,
      traceId: record.traceId,
      threadId,
      payloadSummary: {
        sourceSystem: record.sourceSystem,
        sourceJobId: record.sourceJobId,
        deliveryMode: record.deliveryMode,
        requestedOutputs: record.requestedOutputs,
        inputDigest: record.inputDigest,
        scenario: record.metadata.scenario,
        workflowProfile: record.metadata.workflowProfile,
        collectionSnapshotId: record.metadata.collectionSnapshotId,
        topicId: record.metadata.topicId,
      },
    },
    dispatchState: buildDispatchState(record),
    deduplicated,
    idempotencyKey: record.idempotencyKey,
  };
}

function buildDispatchState(record: FeedAnalysisDispatchRecord): FeedAnalysisDispatchState {
  return {
    accepted: true,
    queued: record.status === 'accepted' || record.status === 'queued',
    failed: record.status === 'failed',
    resultAvailable: record.resultAvailable,
    deliveryMode: record.deliveryMode,
    errorCode: record.errorCode,
  };
}

function normalizeDeliveryMode(value: string): FeedAnalysisDeliveryMode {
  const normalized = value?.trim().toLowerCase();
  if (normalized === 'delivery_only' || normalized === 'result_returning') return normalized;
  throw new FeedAnalysisError('invalid_request', 'deliveryMode must be delivery_only or result_returning', 400);
}

function requireString(value: unknown, field: string): string {
  const normalized = normalizeOptionalString(value);
  if (!normalized) throw new FeedAnalysisError('invalid_request', `${field} is required`, 400);
  return normalized;
}

function normalizeOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export type {
  FeedAnalysisArtifact,
  FeedAnalysisDispatchRequest,
  FeedAnalysisDispatchReceipt,
  FeedAnalysisDispatchResult,
  FeedAnalysisDispatchState,
  FeedAnalysisResultEnvelope,
  FeedAnalysisResultResponse,
  FeedAnalysisScenario,
  FeedAnalysisTarget,
  FeedAnalysisWorkflowProfile,
} from './feed-analysis-types.js';
export { FeedAnalysisError } from './feed-analysis-types.js';
