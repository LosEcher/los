/**
 * @los/agent/integration/feed-analysis-ingress
 *
 * Feed-analysis integration service. Accepts dispatch requests from external
 * systems (lot2extension), creates los run_spec entries, and returns dispatch
 * receipts in the lsclaw-compatible envelope format.
 *
 * Replaces the discontinued lsclaw feed-analysis ingress.
 */

import { randomUUID } from 'node:crypto';
import { createRunSpec, loadRunSpec, type RunSpecRecord } from '../run-specs.js';
import { appendSessionEvent } from '../session-events.js';
import { listTaskRunsForRunSpec } from '../task-runs.js';
import { runScheduledAgentTask } from '../scheduler.js';

// ── Types ──────────────────────────────────────────────────

export interface FeedAnalysisTarget {
  kind: string;
  label: string;
  supportedDeliveryModes: string[];
  supportsResultReturning: boolean;
  status: string;
}

export interface FeedAnalysisDispatchRequest {
  sourceSystem: string;
  sourceJobId: string;
  sourceSessionId?: string;
  deliveryMode: string;
  targetKind?: string;
  payloadVersion?: string;
  requestedOutputs?: string[];
  threadId?: string;
  sessionId?: string;
  callback?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  feedSession?: {
    platform: string;
    pageUrl: string;
    pageKind?: string;
    markReason?: string;
    startedAt?: string;
    endedAt?: string;
    extraJson?: Record<string, unknown>;
  };
  feedObservations?: Array<{
    platform: string;
    itemId: string;
    itemUrl?: string;
    titleOrCaption?: string;
    authorHandle?: string;
    mediaSummary?: Record<string, unknown>;
    interactionSummary?: Record<string, unknown>;
    extraJson?: Record<string, unknown>;
    visibleAt?: string;
  }>;
}

export interface FeedAnalysisDispatchReceipt {
  id: string;
  status: string;
  runId: string;
  traceId?: string;
  threadId?: string;
  payloadSummary?: Record<string, unknown>;
}

export interface FeedAnalysisDispatchState {
  accepted: boolean;
  queued: boolean;
  failed: boolean;
  resultAvailable: boolean;
  deliveryMode: string;
}

export interface FeedAnalysisDispatchResult {
  dispatch: FeedAnalysisDispatchReceipt;
  dispatchState: FeedAnalysisDispatchState;
  deduplicated: boolean;
  idempotencyKey: string;
}

// ── Constants ──────────────────────────────────────────────

const LOS_TARGET: FeedAnalysisTarget = {
  kind: 'los-ingress',
  label: 'los Agent Execution Platform',
  supportedDeliveryModes: ['delivery_only', 'result_returning'],
  supportsResultReturning: true,
  status: 'available',
};

// ── Public API ─────────────────────────────────────────────

export function listFeedAnalysisTargets(): { targets: FeedAnalysisTarget[] } {
  return { targets: [LOS_TARGET] };
}

export async function dispatchFeedAnalysisJob(
  request: FeedAnalysisDispatchRequest,
  idempotencyKey: string,
  workspaceRoot: string,
): Promise<FeedAnalysisDispatchResult> {
  const runId = `fa-${randomUUID()}`;
  const traceId = randomUUID();
  const sessionId = request.sessionId ?? request.sourceSessionId ?? `fa-session-${randomUUID()}`;

  const normalizedRequest = normalizeFeedAnalysisRequest(request);

  const runSpec = await createRunSpec({
    id: runId,
    sessionId,
    traceId,
    prompt: buildIngressPrompt(normalizedRequest),
    workspaceRoot,
    toolMode: 'read-only',
    maxLoops: 1,
    runContract: {
      mode: 'feed-analysis-ingress',
      goal: JSON.stringify({
        sourceSystem: normalizedRequest.sourceSystem,
        sourceJobId: normalizedRequest.sourceJobId,
        deliveryMode: normalizedRequest.deliveryMode,
        targetKind: normalizedRequest.targetKind,
      }),
    },
    modelSettings: {},
  });

  await appendSessionEvent({
    sessionId,
    type: 'feed_analysis.dispatch_received',
    payload: {
      event: 'feed_analysis.dispatch_received',
      runId: runSpec.id,
      sourceSystem: normalizedRequest.sourceSystem,
      sourceJobId: normalizedRequest.sourceJobId,
      deliveryMode: normalizedRequest.deliveryMode,
      targetKind: normalizedRequest.targetKind,
      feedSessionPlatform: normalizedRequest.feedSession?.platform,
      feedSessionPageUrl: normalizedRequest.feedSession?.pageUrl,
      observationCount: normalizedRequest.feedObservations?.length ?? 0,
      idempotencyKey,
    },
  });

  // Fire-and-forget: runScheduledAgentTask creates the task_run and executes
  // the agent loop. We don't await so the dispatch returns immediately.
  runScheduledAgentTask({
    prompt: runSpec.prompt,
    sessionId,
    runSpecId: runSpec.id,
    traceId,
    workspaceRoot,
    toolMode: 'read-only' as const,
    maxLoops: 1,
  }).catch(() => undefined);

  const dispatchState = buildDispatchState(normalizedRequest.deliveryMode, runSpec);

  return {
    dispatch: {
      id: runSpec.id,
      status: 'accepted',
      runId: runSpec.id,
      traceId,
      threadId: normalizedRequest.threadId,
      payloadSummary: {
        sourceSystem: normalizedRequest.sourceSystem,
        sourceJobId: normalizedRequest.sourceJobId,
        deliveryMode: normalizedRequest.deliveryMode,
        observationCount: normalizedRequest.feedObservations?.length ?? 0,
      },
    },
    dispatchState,
    deduplicated: false,
    idempotencyKey,
  };
}

export async function getFeedAnalysisDispatch(
  dispatchId: string,
): Promise<FeedAnalysisDispatchResult | null> {
  const runSpec = await loadRunSpec(dispatchId);
  if (!runSpec) return null;

  // Only return dispatch envelopes for feed-analysis-ingress runs
  if (runSpec.runContract?.mode !== 'feed-analysis-ingress') return null;

  // Derive effective status: prefer the latest task_run status over run_spec
  const taskRuns = await listTaskRunsForRunSpec(dispatchId);
  const latestTaskRun = taskRuns.at(-1);
  const effectiveStatus = latestTaskRun?.status ?? runSpec.status;

  const meta = parseRunSpecGoal(runSpec);
  const deliveryMode = meta.deliveryMode ?? 'delivery_only';
  const dispatchState = buildDispatchState(deliveryMode, runSpec, effectiveStatus);

  return {
    dispatch: {
      id: runSpec.id,
      status: runSpecStatusToDispatchStatus(effectiveStatus),
      runId: runSpec.id,
      traceId: runSpec.traceId,
      threadId: undefined,
      payloadSummary: {
        sourceSystem: meta.sourceSystem,
        sourceJobId: meta.sourceJobId,
        deliveryMode,
      },
    },
    dispatchState,
    deduplicated: false,
    idempotencyKey: '',
  };
}

// ── Helpers ────────────────────────────────────────────────

interface ParsedGoal {
  sourceSystem?: string;
  sourceJobId?: string;
  deliveryMode?: string;
  targetKind?: string;
}

function parseRunSpecGoal(runSpec: RunSpecRecord): ParsedGoal {
  try {
    const goal = runSpec.runContract?.goal;
    if (goal) return JSON.parse(goal) as ParsedGoal;
  } catch {
    // fall through
  }
  return {};
}

interface NormalizedRequest {
  sourceSystem: string;
  sourceJobId: string;
  sourceSessionId?: string;
  deliveryMode: string;
  targetKind: string;
  payloadVersion?: string;
  requestedOutputs: string[];
  threadId?: string;
  sessionId?: string;
  callback?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  feedSession?: FeedAnalysisDispatchRequest['feedSession'];
  feedObservations?: FeedAnalysisDispatchRequest['feedObservations'];
}

function normalizeFeedAnalysisRequest(req: FeedAnalysisDispatchRequest): NormalizedRequest {
  return {
    sourceSystem: req.sourceSystem?.trim() || 'unknown',
    sourceJobId: req.sourceJobId?.trim() || 'unknown',
    sourceSessionId: req.sourceSessionId?.trim() || undefined,
    deliveryMode: normalizeDeliveryMode(req.deliveryMode),
    targetKind: req.targetKind?.trim() || 'los-ingress',
    payloadVersion: req.payloadVersion?.trim() || undefined,
    requestedOutputs: Array.isArray(req.requestedOutputs)
      ? req.requestedOutputs.map(s => s.trim()).filter(Boolean)
      : [],
    threadId: req.threadId?.trim() || undefined,
    sessionId: req.sessionId?.trim() || undefined,
    callback: req.callback && Object.keys(req.callback).length > 0 ? req.callback : undefined,
    metadata: req.metadata && Object.keys(req.metadata).length > 0 ? req.metadata : undefined,
    feedSession: req.feedSession ? {
      platform: req.feedSession.platform?.trim() || 'unknown',
      pageUrl: req.feedSession.pageUrl?.trim() || '',
      pageKind: req.feedSession.pageKind?.trim() || undefined,
      markReason: req.feedSession.markReason?.trim() || undefined,
      startedAt: req.feedSession.startedAt?.trim() || undefined,
      endedAt: req.feedSession.endedAt?.trim() || undefined,
      extraJson: req.feedSession.extraJson,
    } : undefined,
    feedObservations: Array.isArray(req.feedObservations)
      ? req.feedObservations.filter(o => o && o.platform && o.itemId)
      : undefined,
  };
}

function normalizeDeliveryMode(value: string | undefined): string {
  const normalized = value?.trim().toLowerCase();
  if (normalized === 'result_returning') return 'result_returning';
  return 'delivery_only';
}

function buildDispatchState(
  deliveryMode: string,
  runSpec: RunSpecRecord,
  effectiveStatus?: string,
): FeedAnalysisDispatchState {
  const status = effectiveStatus ?? runSpec.status;
  const isTerminal = ['succeeded', 'failed', 'cancelled', 'blocked'].includes(status);
  const isRunning = status === 'running';

  return {
    accepted: true,
    queued: !isRunning && !isTerminal,
    failed: status === 'failed',
    resultAvailable: deliveryMode === 'result_returning' && status === 'succeeded',
    deliveryMode,
  };
}

function runSpecStatusToDispatchStatus(status: string): string {
  switch (status) {
    case 'created':
    case 'queued': return 'accepted';
    case 'running': return 'processing';
    case 'succeeded': return 'completed';
    case 'failed': return 'failed';
    case 'cancelled': return 'cancelled';
    case 'blocked': return 'failed';
    default: return status;
  }
}

function buildIngressPrompt(req: NormalizedRequest): string {
  const parts: string[] = [
    `[Feed Analysis Ingress] Source: ${req.sourceSystem}`,
    `Job: ${req.sourceJobId}`,
    `Delivery mode: ${req.deliveryMode}`,
  ];

  if (req.feedSession) {
    parts.push(`Platform: ${req.feedSession.platform}`);
    parts.push(`Page: ${req.feedSession.pageUrl}`);
    if (req.feedSession.pageKind) parts.push(`Page kind: ${req.feedSession.pageKind}`);
    if (req.feedSession.markReason) parts.push(`Mark reason: ${req.feedSession.markReason}`);
  }

  if (req.feedObservations && req.feedObservations.length > 0) {
    parts.push(`Observations: ${req.feedObservations.length}`);
    for (const obs of req.feedObservations.slice(0, 10)) {
      parts.push(`  - [${obs.platform}] ${obs.itemId} ${obs.titleOrCaption ?? ''}`.trim());
    }
    if (req.feedObservations.length > 10) {
      parts.push(`  ... and ${req.feedObservations.length - 10} more`);
    }
  }

  return parts.join('\n');
}
