export const _FEED_ANALYSIS_CONTRACT_VERSION = 'feed-analysis-v2';
export const _MATERIAL_BUNDLE_VERSION = 'material-bundle-v1';
export const _FEED_ANALYSIS_RESULT_VERSION = 'feed-analysis-result-v1';
export const _FEED_ANALYSIS_WORKFLOW_ID = 'lot2.daily-content';
export const _FEED_ANALYSIS_WORKFLOW_VERSION = '1.0.0';
export const _FEED_ANALYSIS_PROMPT_ID = 'lot2.daily-content.generate';
export const _FEED_ANALYSIS_PROMPT_VERSION = '1.0.0';

export type FeedAnalysisDeliveryMode = 'delivery_only' | 'result_returning';
export type FeedAnalysisOutputKind = 'daily_digest' | 'content_brief' | 'platform_draft';
export type FeedAnalysisPlatform = 'xiaohongshu' | 'zhihu' | 'weibo' | 'x';
export type FeedAnalysisScenario = 'evidence_batch' | 'research_topic';
export type FeedAnalysisWorkflowProfile = 'batch_summary' | 'daily_content' | 'research_deep';
export type FeedAnalysisStatus =
  | 'accepted'
  | 'queued'
  | 'processing'
  | 'result_ready'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface FeedAnalysisTarget {
  kind: string;
  label: string;
  contractVersions: string[];
  supportedDeliveryModes: FeedAnalysisDeliveryMode[];
  supportedOutputs: FeedAnalysisOutputKind[];
  supportedScenarios: FeedAnalysisScenario[];
  supportedWorkflowProfiles: FeedAnalysisWorkflowProfile[];
  supportedPlatforms: FeedAnalysisPlatform[];
  supportedLocales: string[];
  supportsResultReturning: boolean;
  supportsCallback: boolean;
  supportsCancellation: boolean;
  maxInlineBytes: number;
  maxItems: number;
  status: string;
}

export interface MaterialBundleItem {
  itemId: string;
  platform: string;
  itemUrl?: string;
  titleOrCaption?: string;
  authorHandle?: string;
  content?: string;
  mediaSummary?: Record<string, unknown>;
  interactionSummary?: Record<string, unknown>;
  visibleAt?: string;
  extraJson?: Record<string, unknown>;
}

export interface MaterialBundle {
  schemaVersion: 'material-bundle-v1';
  bundleId: string;
  sourceSystem: string;
  timeRange?: { start?: string; end?: string };
  selection?: Record<string, unknown>;
  items: MaterialBundleItem[];
  requestedOutputs?: FeedAnalysisOutputKind[];
  policy?: {
    locale?: string;
    citationRequired?: boolean;
    allowExternalResearch?: boolean;
    retentionDays?: number;
  };
}

export interface MaterialBundleRef {
  bundleId: string;
  inputDigest: string;
  url: string;
  expiresAt: string;
  sizeBytes?: number;
}

export interface FeedAnalysisDispatchRequest {
  sourceSystem: string;
  sourceJobId: string;
  sourceSessionId?: string;
  scenario?: FeedAnalysisScenario | string;
  deliveryMode: FeedAnalysisDeliveryMode | string;
  targetKind?: string;
  payloadVersion?: string;
  requestedOutputs?: FeedAnalysisOutputKind[] | string[];
  threadId?: string;
  sessionId?: string;
  callback?: { profileId?: string };
  metadata?: Record<string, unknown>;
  collectionSnapshot?: {
    snapshotId: string;
    createdAt?: string;
    observationCount: number;
    dedupePolicy?: string;
  };
  topic?: {
    topicId: string;
    title: string;
    brief?: string;
    targetPlatforms?: string[];
  };
  workflowHint?: {
    profile?: FeedAnalysisWorkflowProfile | string;
    maxLoops?: number;
  };
  materialBundle?: MaterialBundle;
  materialBundleRef?: MaterialBundleRef;
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

export interface FeedAnalysisArtifact {
  artifactId: string;
  kind: FeedAnalysisOutputKind;
  platform?: FeedAnalysisPlatform;
  locale: string;
  title?: string;
  titleCandidates: string[];
  body: string;
  hashtags: string[];
  structuredPayload: Record<string, unknown>;
  citationRefs: string[];
  workflowId: string;
  workflowVersion: string;
  promptId: string;
  promptVersion: string;
  reviewStatus: 'draft' | 'reviewed' | 'rejected';
}

export interface FeedAnalysisCitation {
  id: string;
  itemId?: string;
  url?: string;
  title?: string;
}

export interface FeedAnalysisResultEnvelope {
  schemaVersion: 'feed-analysis-result-v1';
  summary: string;
  artifacts: FeedAnalysisArtifact[];
  citations: FeedAnalysisCitation[];
  warnings: string[];
  workflow: { id: string; version: string };
  prompt: { id: string; version: string };
  provider?: { name?: string; model?: string };
  usage?: { promptTokens: number; completionTokens: number; durationMs?: number; costUsd?: number };
  resultDigest?: string;
}

export interface FeedAnalysisDispatchReceipt {
  id: string;
  status: FeedAnalysisStatus;
  runId?: string;
  traceId?: string;
  threadId?: string;
  payloadSummary?: Record<string, unknown>;
}

export interface FeedAnalysisDispatchState {
  accepted: boolean;
  queued: boolean;
  failed: boolean;
  resultAvailable: boolean;
  deliveryMode: FeedAnalysisDeliveryMode;
  errorCode?: string;
}

export interface FeedAnalysisDispatchResult {
  dispatch: FeedAnalysisDispatchReceipt;
  dispatchState: FeedAnalysisDispatchState;
  deduplicated: boolean;
  idempotencyKey: string;
}

export interface FeedAnalysisResultResponse {
  dispatchId: string;
  status: FeedAnalysisStatus;
  resultAvailable: boolean;
  result?: FeedAnalysisResultEnvelope;
  error?: { code: string; message: string };
}

export class FeedAnalysisError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly httpStatus: number,
  ) {
    super(message);
    this.name = 'FeedAnalysisError';
  }
}
