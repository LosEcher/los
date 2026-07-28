/**
 * @los/agent/route-healthy — Health-aware routing with prefix-cache affinity.
 *
 * Combines provider health tracking with prefix-cache affinity to select the
 * best provider for a request. Inspired by Mooncake's KV-cache pooling and
 * rank-activeness-aware routing.
 *
 * Strategy:
 *  1. Filter out unavailable (circuit-open) providers
 *  2. Prefer providers with active cache sessions (sessionAffinity)
 *  3. Rank remaining by health score (latency + error rate)
 *  4. Return the best candidate (or null if none healthy)
 */

import type { ProviderHealthRanker } from './provider-health.js';

export interface CacheAffinityRecord {
  provider: string;
  model: string;
  /** Total cache-hit tokens observed. */
  totalCacheHitTokens: number;
  /** Cache-hit rate (0-1) over recent calls. */
  cacheHitRate: number;
  /** Timestamp of last cache activity. */
  lastCacheActivityAt: number;
}

export interface RouteHealthyInput {
  /** Candidate providers in preference order. */
  candidates: Array<{ provider: string; model: string }>;
  /** Health ranker from provider-health module. */
  rankHealthy: ProviderHealthRanker;
  /** Optional cache affinity data for each candidate. */
  cacheAffinity?: Map<string, CacheAffinityRecord>;
  /** Prefer providers with recent cache activity (default: true). */
  preferCacheAffinity?: boolean;
  /** Max age (ms) for cache activity to be considered "recent" (default: 300_000 = 5 min). */
  cacheAffinityMaxAgeMs?: number;
}

export interface RouteHealthyResult {
  selected: { provider: string; model: string } | null;
  /** Reason for the selection. */
  reason: 'healthy_cache_affinity' | 'healthy_top_ranked' | 'no_healthy_candidates';
  /** All candidates sorted by preference (best first). */
  ranked: Array<{ provider: string; model: string; score: number }>;
}

const DEFAULT_CACHE_AFFINITY_MAX_AGE_MS = 300_000; // 5 minutes

export function routeHealthy(input: RouteHealthyInput): RouteHealthyResult {
  const { candidates, rankHealthy, cacheAffinity, preferCacheAffinity = true } = input;
  if (candidates.length === 0) {
    return { selected: null, reason: 'no_healthy_candidates', ranked: [] };
  }

  const maxAge = input.cacheAffinityMaxAgeMs ?? DEFAULT_CACHE_AFFINITY_MAX_AGE_MS;
  const providerNames = candidates.map(c => c.provider);

  // Filter: only consider healthy candidates
  const rankedProviders = rankHealthy(providerNames);

  if (rankedProviders.length === 0) {
    return { selected: null, reason: 'no_healthy_candidates', ranked: [] };
  }

  // Map ranked providers back to candidates, preserving order
  const rankedSet = new Set(rankedProviders);
  const healthyCandidates = candidates.filter(c => rankedSet.has(c.provider));

  // Build score map
  const scoreMap = new Map<string, number>();
  rankedProviders.forEach((p, i) => scoreMap.set(p, rankedProviders.length - i));

  // Check cache affinity: if a healthy provider has recent cache activity,
  // boost its preference.
  if (preferCacheAffinity && cacheAffinity && cacheAffinity.size > 0) {
    const now = Date.now();
    const cacheBoosted = healthyCandidates
      .map(candidate => {
        const key = cacheAffinityKey(candidate.provider, candidate.model);
        const affinity = cacheAffinity.get(key);
        const cacheRecent = affinity && (now - affinity.lastCacheActivityAt) < maxAge;
        return {
          candidate,
          cacheRecent,
          cacheHitRate: affinity?.cacheHitRate ?? 0,
          baseScore: scoreMap.get(candidate.provider) ?? 0,
        };
      })
      .sort((a, b) => {
        // Cache-recent candidates first
        if (a.cacheRecent !== b.cacheRecent) return a.cacheRecent ? -1 : 1;
        // Then by health score (higher better)
        return b.baseScore - a.baseScore;
      });

    const best = cacheBoosted[0];
    if (best) {
      const reason = best.cacheRecent ? 'healthy_cache_affinity' : 'healthy_top_ranked';
      return {
        selected: best.candidate,
        reason,
        ranked: cacheBoosted.map(item => ({
          provider: item.candidate.provider,
          model: item.candidate.model,
          score: (item.cacheRecent ? 100 : 0) + item.baseScore,
        })),
      };
    }
  }

  // No cache affinity: pick the healthiest candidate by score
  const sorted = [...healthyCandidates].sort((a, b) =>
    (scoreMap.get(b.provider) ?? 0) - (scoreMap.get(a.provider) ?? 0)
  );
  const best = sorted[0];
  return {
    selected: best ?? null,
    reason: best ? 'healthy_top_ranked' : 'no_healthy_candidates',
    ranked: sorted.map(candidate => ({
      provider: candidate.provider,
      model: candidate.model,
      score: scoreMap.get(candidate.provider) ?? 0,
    })),
  };
}

export function cacheAffinityKey(provider: string, model: string): string {
  return `${provider}:${model}`;
}
