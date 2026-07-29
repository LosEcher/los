/**
 * @los/agent/providers/provider-health — Health-aware provider scoring.
 *
 * ADR 0031: Computes a composite health score from three weighted signals:
 *   - RTT (40%): Latest probe RTT from provider-probe.ts, linearly normalized
 *   - Success rate (40%): succeeded/total ratio from scheduler-decision-ledger (24h)
 *   - Availability (20%): Whether the provider is reachable (probe healthy flag)
 *
 * Scores drive tiered routing:
 *   ≥ 0.8 → healthy  — normal routing, highest preference
 *   0.5-0.8 → degraded — usable but prefer alternatives
 *   < 0.5 → unhealthy — skip if alternatives exist, log alert
 *
 * When no data is available (no probe, no outcomes), the score defaults to
 * 0.5 (degraded, neutral — doesn't penalize unprobed providers).
 */

import type { ProbeResult } from './provider-probe.js';

// ── Types ──────────────────────────────────────────────

export interface ProviderRecentOutcome {
  provider: string;
  model: string;
  totalTasks: number;
  succeeded: number;
  failed: number;
  avgDurationMs: number;
  avgTokens: number;
  lastOutcomeAt: string;
}

export interface HealthScoreComponents {
  /** Normalized RTT score: 1.0 (0ms) → 0.0 (≥5000ms). Default 0.5 when no probe. */
  rttScore: number;
  /** Success rate: succeeded/total. Default 1.0 when no outcome data (benefit of doubt). */
  successRate: number;
  /** Availability: 1.0 if probe is healthy, 0.0 if unhealthy, 0.5 if no probe. */
  availabilityScore: number;
}

export interface HealthScore {
  provider: string;
  /** Composite score 0.0–1.0 */
  score: number;
  /** Routing tier derived from score */
  tier: HealthTier;
  /** Weighted components (for debugging / dashboards) */
  components: HealthScoreComponents;
  /** Raw data used for computation */
  details: {
    rttMs?: number;
    probeHealthy?: boolean;
    lastProbedAt?: string;
    successCount?: number;
    totalCount?: number;
    lastOutcomeAt?: string;
    hasProbe: boolean;
    hasOutcomes: boolean;
  };
}

export type HealthTier = 'healthy' | 'degraded' | 'unhealthy' | 'unknown';

// ── Constants ───────────────────────────────────────────

/** RTT values at or above this are scored 0.0 */
const RTT_MAX_MS = 5000;

/** Weights per ADR 0031 */
const WEIGHT_RTT = 0.4;
const WEIGHT_SUCCESS = 0.4;
const WEIGHT_AVAILABILITY = 0.2;

/** At least this many total tasks before success rate is trusted */
const MIN_TASKS_FOR_SUCCESS_TRUST = 3;

// ── Public API ──────────────────────────────────────────

/**
 * Compute a health score for a single provider.
 *
 * @param provider - Provider name
 * @param probe - Latest probe result (from provider-probe.ts), or undefined
 * @param outcomes - Recent task outcomes (from getProviderRecentOutcomes), or undefined
 */
export function computeHealthScore(
  provider: string,
  probe?: ProbeResult,
  outcomes?: ProviderRecentOutcome,
): HealthScore {
  const hasProbe = Boolean(probe);
  const hasOutcomes = Boolean(outcomes);

  // ── RTT score (40%) ──────────────────────────────────
  let rttScore: number;
  if (probe?.healthy && probe.rttMs > 0) {
    // Linear normalization: 0ms → 1.0, RTT_MAX_MS → 0.0
    rttScore = Math.max(0, 1 - probe.rttMs / RTT_MAX_MS);
  } else if (probe && !probe.healthy) {
    // Unhealthy probe → penalize RTT score
    rttScore = 0;
  } else {
    // No probe data → neutral
    rttScore = 0.5;
  }

  // ── Success rate (40%) ────────────────────────────────
  let successRate: number;
  if (outcomes && outcomes.totalTasks >= MIN_TASKS_FOR_SUCCESS_TRUST) {
    successRate = outcomes.succeeded / outcomes.totalTasks;
  } else if (outcomes && outcomes.totalTasks > 0) {
    // Too few tasks to trust fully — weight toward 0.5
    const rawRate = outcomes.succeeded / outcomes.totalTasks;
    const trustWeight = outcomes.totalTasks / MIN_TASKS_FOR_SUCCESS_TRUST;
    successRate = rawRate * trustWeight + 0.5 * (1 - trustWeight);
  } else {
    // No outcome data → benefit of doubt (don't penalize new/untested providers)
    successRate = 1.0;
  }

  // ── Availability (20%) ────────────────────────────────
  let availabilityScore: number;
  if (probe) {
    availabilityScore = probe.healthy ? 1.0 : 0.0;
  } else {
    availabilityScore = 0.5; // unknown → neutral
  }

  // ── Composite ─────────────────────────────────────────
  const score = round2(
    WEIGHT_RTT * rttScore +
    WEIGHT_SUCCESS * successRate +
    WEIGHT_AVAILABILITY * availabilityScore,
  );

  return {
    provider,
    score,
    tier: classifyTier(score),
    components: { rttScore: round2(rttScore), successRate: round2(successRate), availabilityScore },
    details: {
      rttMs: probe?.rttMs,
      probeHealthy: probe?.healthy,
      lastProbedAt: probe?.probedAt,
      successCount: outcomes?.succeeded,
      totalCount: outcomes?.totalTasks,
      lastOutcomeAt: outcomes?.lastOutcomeAt,
      hasProbe,
      hasOutcomes,
    },
  };
}

/**
 * Rank providers by health score (descending — healthiest first).
 * Providers in the same tier are ordered by raw score.
 */
export function rankByHealth(scores: HealthScore[]): HealthScore[] {
  const tierOrder: Record<HealthTier, number> = {
    healthy: 0,
    degraded: 1,
    unknown: 2,
    unhealthy: 3,
  };
  return [...scores].sort((a, b) => {
    const tierDiff = tierOrder[a.tier] - tierOrder[b.tier];
    if (tierDiff !== 0) return tierDiff;
    return b.score - a.score;
  });
}

/**
 * Select the healthiest provider from a list of candidates.
 * Returns undefined if the list is empty.
 */
export function selectHealthiest(scores: HealthScore[]): HealthScore | undefined {
  if (scores.length === 0) return undefined;
  return rankByHealth(scores)[0];
}

/**
 * Check whether a provider should be skipped entirely (unhealthy tier).
 */
export function isUnhealthy(score: HealthScore): boolean {
  return score.tier === 'unhealthy';
}

/**
 * Check whether a provider is preferred over another for routing decisions.
 * Returns true if `a` has a meaningfully higher health tier than `b`.
 */
export function isHealthierThan(a: HealthScore, b: HealthScore): boolean {
  const tierOrder: Record<HealthTier, number> = {
    healthy: 0, degraded: 1, unknown: 2, unhealthy: 3,
  };
  return tierOrder[a.tier] < tierOrder[b.tier];
}

// ── Internal helpers ────────────────────────────────────

function classifyTier(score: number): HealthTier {
  if (score >= 0.8) return 'healthy';
  if (score >= 0.5) return 'degraded';
  return 'unhealthy';
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
