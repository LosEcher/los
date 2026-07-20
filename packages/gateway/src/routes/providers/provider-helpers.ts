/**
 * Sanitizer helpers shared across provider route handlers.
 * Extracted from provider-routes.ts to keep each file under 400 lines.
 */
import type { DiscoveredProvider } from '@los/infra/discovery';
import {
  normalizeOptionalString,
  normalizeBoundedInteger,
  normalizeNonNegativeNumber,
  truncateForHttp,
  normalizeProviderSummaryStringArray,
} from '../server-helpers.js';
import { describeProviderReadiness } from '@los/infra/discovery';

export function sanitizeProviderDiscovery(provider: DiscoveredProvider, compatEvidence: Array<{
  provider?: string;
  model?: string;
  decision?: string;
  passed?: boolean;
  summary?: Record<string, unknown>;
}>): Record<string, unknown> {
  const evidenceForProvider = compatEvidence.filter(e => e.provider === provider.name);
  const latest = evidenceForProvider.at(0);
  const readiness = describeProviderReadiness(provider);
  return {
    name: provider.name,
    displayName: (provider as any).displayName ?? provider.name,
    defaultModel: provider.defaultModel,
    available: provider.available,
    source: provider.source,
    readiness,
    compatEvidence: {
      count: evidenceForProvider.length,
      latestVerdict: latest?.decision ?? null,
      latestDecision: latest?.decision ?? null,
      latestPassed: latest?.passed ?? null,
      latest: latest ?? null,
    },
  };
}

export function sanitizeProviderCompatEvidence(item: {
  id: string;
  provider: string;
  model?: string;
  probeId: string;
  targetLabel: string;
  decision: string;
  passed: boolean;
  sessionId?: string;
  taskRunId?: string;
  runSpecId?: string;
  traceId?: string;
  requestId?: string;
  nodeId?: string;
  totalTokens: number;
  summary: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}): Record<string, unknown> {
  return {
    id: item.id,
    provider: item.provider,
    model: item.model ?? null,
    probeId: item.probeId,
    targetLabel: item.targetLabel,
    decision: item.decision,
    passed: item.passed,
    sessionId: item.sessionId ?? null,
    taskRunId: item.taskRunId ?? null,
    runSpecId: item.runSpecId ?? null,
    traceId: item.traceId ?? null,
    requestId: item.requestId ?? null,
    nodeId: item.nodeId ?? null,
    totalTokens: item.totalTokens,
    summary: sanitizeProviderCompatSummary(item.summary),
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  };
}

export function sanitizeProviderCompatSummary(summary: Record<string, unknown>): Record<string, unknown> {
  const routeReason = normalizeOptionalString(summary.routeReason);
  return {
    completed: summary.completed === true,
    cancelled: summary.cancelled === true,
    routeReason: isModelRouteReason(routeReason) ? routeReason : null,
    reasoningObserved: summary.reasoningObserved === true,
    toolCalls: normalizeProviderSummaryStringArray(summary.toolCalls, 12),
    toolResultCount: normalizeNonNegativeNumber(summary.toolResultCount),
    failedToolResultCount: normalizeNonNegativeNumber(summary.failedToolResultCount),
    deniedToolCount: normalizeNonNegativeNumber(summary.deniedToolCount),
    failures: normalizeProviderSummaryStringArray(summary.failures, 8).map(failure => truncateForHttp(failure, 240)),
  };
}

function isModelRouteReason(value: string | undefined): boolean {
  return value === 'configured_default'
    || value === 'explicit_provider'
    || value === 'explicit_model'
    || value === 'explicit_fallback_policy'
    || value === 'architect_editor_override';
}

export type RunEvalQuery = {
  runSpecId?: string; sessionId?: string; taskRunId?: string;
  provider?: string; model?: string; success?: string;
  verificationStatus?: string; failureClass?: string; failoverScope?: string;
  createdFrom?: string; createdTo?: string;
  baselineFrom?: string; baselineTo?: string;
  candidateFrom?: string; candidateTo?: string;
  limit?: string;
};

export function parseRunEvalQuery(query: RunEvalQuery): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const strFields = ['runSpecId', 'sessionId', 'taskRunId', 'provider', 'model',
    'verificationStatus', 'failureClass', 'failoverScope',
    'createdFrom', 'createdTo', 'baselineFrom', 'baselineTo', 'candidateFrom', 'candidateTo'];
  for (const f of strFields) {
    const v = normalizeOptionalString((query as any)[f]);
    if (v) out[f] = v;
  }
  if (query.success === 'true') out.success = true;
  else if (query.success === 'false') out.success = false;
  out.limit = normalizeBoundedInteger(query.limit, 100, 1, 1000);
  return out;
}

export function parseProviderPromotionAction(value: unknown): 'promote_required' | 'demote_advisory' {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed === 'promote_required' || trimmed === 'demote_advisory') return trimmed;
  }
  return 'demote_advisory';
}
