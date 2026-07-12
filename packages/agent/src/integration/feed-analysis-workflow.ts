import { isIP } from 'node:net';
import { lookup } from 'node:dns/promises';
import { randomUUID } from 'node:crypto';
import {
  _FEED_ANALYSIS_PROMPT_ID,
  _FEED_ANALYSIS_PROMPT_VERSION,
  _FEED_ANALYSIS_RESULT_VERSION,
  _FEED_ANALYSIS_WORKFLOW_ID,
  _FEED_ANALYSIS_WORKFLOW_VERSION,
  _MATERIAL_BUNDLE_VERSION,
  type FeedAnalysisArtifact,
  type FeedAnalysisDispatchRequest,
  type FeedAnalysisOutputKind,
  type FeedAnalysisPlatform,
  type FeedAnalysisResultEnvelope,
  type MaterialBundle,
  FeedAnalysisError,
} from './feed-analysis-types.js';
import { digestJson } from './feed-analysis-store.js';

const OUTPUTS = new Set<FeedAnalysisOutputKind>(['daily_digest', 'content_brief', 'platform_draft']);
const PLATFORMS = new Set<FeedAnalysisPlatform>(['xiaohongshu', 'weibo', 'x']);

export interface FeedAnalysisWorkflowLimits {
  maxInlineBytes: number;
  maxItems: number;
  materialHosts: string[];
  materialFetchTimeoutMs: number;
}

export interface PreparedFeedAnalysisInput {
  materialBundle: MaterialBundle;
  inputDigest: string;
  requestedOutputs: FeedAnalysisOutputKind[];
  policy: Record<string, unknown>;
}

export async function prepareFeedAnalysisInput(
  request: FeedAnalysisDispatchRequest,
  limits: FeedAnalysisWorkflowLimits,
): Promise<PreparedFeedAnalysisInput> {
  const supplied = [request.materialBundle, request.materialBundleRef].filter(Boolean).length;
  if (supplied > 1) {
    throw new FeedAnalysisError('invalid_request', 'provide materialBundle or materialBundleRef, not both', 400);
  }

  let bundle: MaterialBundle;
  if (request.materialBundle) {
    assertInlineSize(request.materialBundle, limits.maxInlineBytes);
    bundle = request.materialBundle;
  } else if (request.materialBundleRef) {
    bundle = await fetchMaterialBundle(request.materialBundleRef, limits);
  } else {
    bundle = legacyMaterialBundle(request);
  }

  validateMaterialBundle(bundle, request.sourceSystem, limits.maxItems);
  const requestedOutputs = normalizeRequestedOutputs(request.requestedOutputs ?? bundle.requestedOutputs);
  const policy = normalizePolicy(bundle.policy);
  return {
    materialBundle: bundle,
    inputDigest: digestJson({
      sourceSystem: request.sourceSystem.trim(),
      sourceJobId: request.sourceJobId.trim(),
      deliveryMode: normalizeDeliveryMode(request.deliveryMode),
      bundle,
      requestedOutputs,
      policy,
    }),
    requestedOutputs,
    policy,
  };
}

export function buildFeedAnalysisWorkflowPrompt(input: PreparedFeedAnalysisInput): string {
  const locale = typeof input.policy.locale === 'string' ? input.policy.locale : 'zh-CN';
  const items = input.materialBundle.items.map(item => ({
    itemId: item.itemId,
    platform: item.platform,
    itemUrl: item.itemUrl,
    titleOrCaption: truncate(item.titleOrCaption, 500),
    authorHandle: truncate(item.authorHandle, 200),
    content: truncate(item.content, 1500),
    interactionSummary: item.interactionSummary,
  }));
  return [
    'Produce a feed-analysis result as strict JSON with no markdown fence.',
    `Use schemaVersion "${_FEED_ANALYSIS_RESULT_VERSION}".`,
    `Requested outputs: ${input.requestedOutputs.join(', ') || 'daily_digest'}.`,
    `Locale: ${locale}. External research allowed: ${input.policy.allowExternalResearch === true}.`,
    'Required top-level keys: summary, artifacts, citations, warnings.',
    'Each artifact requires kind, body, and optional platform/title/titleCandidates/hashtags/citationRefs.',
    'Use only supplied item IDs in citations. Do not invent URLs or publishing claims.',
    JSON.stringify({ bundleId: input.materialBundle.bundleId, items }),
  ].join('\n');
}

export function parseFeedAnalysisWorkflowResult(
  text: string,
  input: PreparedFeedAnalysisInput,
  runtime?: { provider?: string; model?: string; promptTokens?: number; completionTokens?: number; durationMs?: number },
): FeedAnalysisResultEnvelope {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripJsonFence(text));
  } catch {
    throw new FeedAnalysisError('result_invalid', 'workflow output is not valid JSON', 422);
  }
  const root = readObject(parsed);
  const summary = readRequiredString(root.summary, 'result summary');
  const locale = typeof input.policy.locale === 'string' ? input.policy.locale : 'zh-CN';
  const citations = Array.isArray(root.citations)
    ? root.citations.map(readObject).map((citation, index) => ({
        id: readString(citation.id) ?? `src_${index + 1}`,
        itemId: readString(citation.itemId),
        url: readString(citation.url),
        title: readString(citation.title),
      }))
    : [];
  const warnings = readStringArray(root.warnings);
  const rawArtifacts = Array.isArray(root.artifacts) ? root.artifacts : [];
  const artifacts = rawArtifacts.map((value, index) => normalizeArtifact(value, index, locale));
  assertRequestedArtifacts(input.requestedOutputs, artifacts);
  return {
    schemaVersion: _FEED_ANALYSIS_RESULT_VERSION,
    summary,
    artifacts,
    citations,
    warnings,
    workflow: { id: _FEED_ANALYSIS_WORKFLOW_ID, version: _FEED_ANALYSIS_WORKFLOW_VERSION },
    prompt: { id: _FEED_ANALYSIS_PROMPT_ID, version: _FEED_ANALYSIS_PROMPT_VERSION },
    provider: runtime?.provider || runtime?.model ? { name: runtime.provider, model: runtime.model } : undefined,
    usage: {
      promptTokens: runtime?.promptTokens ?? 0,
      completionTokens: runtime?.completionTokens ?? 0,
      durationMs: runtime?.durationMs,
    },
  };
}

function normalizeArtifact(value: unknown, index: number, locale: string): FeedAnalysisArtifact {
  const raw = readObject(value);
  const kind = readString(raw.kind) as FeedAnalysisOutputKind | undefined;
  if (!kind || !OUTPUTS.has(kind)) throw new FeedAnalysisError('result_invalid', `artifact ${index} has invalid kind`, 422);
  const platformValue = readString(raw.platform);
  const platform = platformValue && PLATFORMS.has(platformValue as FeedAnalysisPlatform)
    ? platformValue as FeedAnalysisPlatform
    : undefined;
  if (kind === 'platform_draft' && !platform) {
    throw new FeedAnalysisError('result_invalid', `artifact ${index} requires a supported platform`, 422);
  }
  return {
    artifactId: readString(raw.artifactId) ?? `fa-art-${randomUUID()}`,
    kind,
    platform,
    locale: readString(raw.locale) ?? locale,
    title: readString(raw.title),
    titleCandidates: readStringArray(raw.titleCandidates),
    body: readRequiredString(raw.body, `artifact ${index} body`),
    hashtags: readStringArray(raw.hashtags),
    structuredPayload: readObject(raw.structuredPayload),
    citationRefs: readStringArray(raw.citationRefs),
    workflowId: _FEED_ANALYSIS_WORKFLOW_ID,
    workflowVersion: _FEED_ANALYSIS_WORKFLOW_VERSION,
    promptId: _FEED_ANALYSIS_PROMPT_ID,
    promptVersion: _FEED_ANALYSIS_PROMPT_VERSION,
    reviewStatus: 'draft',
  };
}

function assertRequestedArtifacts(requested: FeedAnalysisOutputKind[], artifacts: FeedAnalysisArtifact[]): void {
  for (const output of requested) {
    if (!artifacts.some(artifact => artifact.kind === output)) {
      throw new FeedAnalysisError('result_invalid', `workflow result is missing requested output ${output}`, 422);
    }
  }
}

async function fetchMaterialBundle(
  ref: NonNullable<FeedAnalysisDispatchRequest['materialBundleRef']>,
  limits: FeedAnalysisWorkflowLimits,
): Promise<MaterialBundle> {
  const expiresAt = new Date(ref.expiresAt);
  if (!Number.isFinite(expiresAt.getTime()) || expiresAt.getTime() <= Date.now()) {
    throw new FeedAnalysisError('material_invalid', 'material bundle URL is expired', 422);
  }
  const url = await validateMaterialUrl(ref.url, limits.materialHosts);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), limits.materialFetchTimeoutMs);
  try {
    const response = await fetch(url, { redirect: 'error', signal: controller.signal });
    if (!response.ok) throw new FeedAnalysisError('material_invalid', `material fetch failed with HTTP ${response.status}`, 422);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.byteLength > limits.maxInlineBytes || (ref.sizeBytes && bytes.byteLength !== ref.sizeBytes)) {
      throw new FeedAnalysisError('material_too_large', 'material bundle size is invalid', 413);
    }
    const parsed = JSON.parse(bytes.toString('utf8')) as MaterialBundle;
    if (digestJson(parsed) !== ref.inputDigest) {
      throw new FeedAnalysisError('material_invalid', 'material bundle digest mismatch', 422);
    }
    return parsed;
  } catch (error) {
    if (error instanceof FeedAnalysisError) throw error;
    throw new FeedAnalysisError('material_invalid', `material fetch failed: ${error instanceof Error ? error.message : String(error)}`, 422);
  } finally {
    clearTimeout(timeout);
  }
}

async function validateMaterialUrl(value: string, allowedHosts: string[]): Promise<URL> {
  let url: URL;
  try { url = new URL(value); } catch { throw new FeedAnalysisError('material_invalid', 'material URL is invalid', 422); }
  if (url.protocol !== 'https:' || url.username || url.password) {
    throw new FeedAnalysisError('material_invalid', 'material URL must be HTTPS without credentials', 422);
  }
  if (allowedHosts.length === 0 || !allowedHosts.includes(url.hostname)) {
    throw new FeedAnalysisError('material_invalid', 'material URL host is not allowlisted', 422);
  }
  const addresses = isIP(url.hostname) ? [{ address: url.hostname }] : await lookup(url.hostname, { all: true });
  if (addresses.some(item => isPrivateAddress(item.address))) {
    throw new FeedAnalysisError('material_invalid', 'material URL resolves to a private address', 422);
  }
  return url;
}

function legacyMaterialBundle(request: FeedAnalysisDispatchRequest): MaterialBundle {
  const observations = request.feedObservations ?? [];
  return {
    schemaVersion: _MATERIAL_BUNDLE_VERSION,
    bundleId: request.sourceSessionId ?? `legacy-${request.sourceJobId}`,
    sourceSystem: request.sourceSystem,
    items: observations.map(item => ({ ...item })),
    requestedOutputs: normalizeRequestedOutputs(request.requestedOutputs),
    policy: { locale: 'zh-CN', citationRequired: true, allowExternalResearch: false },
  };
}

function validateMaterialBundle(bundle: MaterialBundle, sourceSystem: string, maxItems: number): void {
  if (bundle.schemaVersion !== _MATERIAL_BUNDLE_VERSION) throw new FeedAnalysisError('material_invalid', 'unsupported material bundle version', 422);
  if (!bundle.bundleId?.trim() || bundle.sourceSystem !== sourceSystem) throw new FeedAnalysisError('material_invalid', 'material bundle identity is invalid', 422);
  if (!Array.isArray(bundle.items) || bundle.items.length === 0) throw new FeedAnalysisError('material_invalid', 'material bundle has no items', 422);
  if (bundle.items.length > maxItems) throw new FeedAnalysisError('material_too_large', `material bundle exceeds ${maxItems} items`, 413);
  for (const [index, item] of bundle.items.entries()) {
    if (!item?.itemId?.trim() || !item.platform?.trim()) throw new FeedAnalysisError('material_invalid', `material item ${index} is invalid`, 422);
  }
}

function normalizeRequestedOutputs(value: unknown): FeedAnalysisOutputKind[] {
  const outputs = Array.isArray(value) ? value : [];
  const normalized = [...new Set(outputs.filter((item): item is FeedAnalysisOutputKind => typeof item === 'string' && OUTPUTS.has(item as FeedAnalysisOutputKind)))];
  if (normalized.length !== outputs.length) throw new FeedAnalysisError('capability_unsupported', 'requested output is unsupported', 422);
  return normalized.length > 0 ? normalized : ['daily_digest'];
}

function normalizePolicy(value: MaterialBundle['policy']): Record<string, unknown> {
  const locale = value?.locale ?? 'zh-CN';
  if (locale !== 'zh-CN') throw new FeedAnalysisError('capability_unsupported', `locale ${locale} is unsupported`, 422);
  return {
    locale,
    citationRequired: value?.citationRequired !== false,
    allowExternalResearch: value?.allowExternalResearch === true,
    retentionDays: normalizeRetentionDays(value?.retentionDays),
  };
}

function normalizeRetentionDays(value: unknown): number {
  const days = typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : 30;
  return Math.max(1, Math.min(90, days));
}

function normalizeDeliveryMode(value: string): string {
  return value.trim().toLowerCase();
}

function assertInlineSize(value: unknown, maxBytes: number): void {
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > maxBytes) {
    throw new FeedAnalysisError('material_too_large', `inline material exceeds ${maxBytes} bytes`, 413);
  }
}

function stripJsonFence(text: string): string {
  const trimmed = text.trim();
  const match = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return match?.[1] ?? trimmed;
}

function truncate(value: unknown, max: number): string | undefined {
  const text = readString(value);
  return text && text.length > max ? `${text.slice(0, max)}…` : text;
}

function readObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function readRequiredString(value: unknown, field: string): string {
  const text = readString(value);
  if (!text) throw new FeedAnalysisError('result_invalid', `${field} is required`, 422);
  return text;
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(readString).filter((item): item is string => Boolean(item)) : [];
}

function isPrivateAddress(address: string): boolean {
  const normalized = address.toLowerCase();
  return normalized === '::1' || normalized.startsWith('fc') || normalized.startsWith('fd') || normalized.startsWith('fe80:')
    || /^127\./.test(normalized) || /^10\./.test(normalized) || /^192\.168\./.test(normalized)
    || /^169\.254\./.test(normalized) || /^172\.(1[6-9]|2\d|3[01])\./.test(normalized);
}
