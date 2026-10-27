/**
 * @los/agent/providers/provider-health — Health-aware provider scoring.
 *
 * ADR 0043: Computes a composite health score from three weighted signals:
 *   - RTT (40%): Latest probe RTT from provider-probe.ts, linearly normalized
 *   - Success rate (40%): succeeded/total ratio from scheduler-decision-ledger (24h)
 *   - Availability (20%): Whether the provider is reachable (probe healthy flag)
 *
 * Scores drive tiered routing:
 *   ≥ 0.8 → healthy  — normal routing, highest preference
 *   0.5-0.8 → degraded — usable but prefer alternatives
 *   < 0.5 → unhealthy — skip if alternatives exist, log alert
 *
 * Cold start is a composition, not a 0.5 default: with no probe the RTT component
 * is 0.5 (weight 0.4), with no outcomes the success component is 1.0 (weight 0.4),
 * and with no probe the availability component is 0.5 (weight 0.2) — a composite of
 * 0.7, which `classifyTier` maps to `degraded`. Read the components, not a single
 * "default 0.5".
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

/**
 * **原因桶**：把 tier 拆成"为什么"。
 *
 * 唯一实现 —— `/providers/health` 的 `reason`（每个 provider）与 `reasons`（直方图）都从这里来。
 *
 * 为什么需要：`tier` 只有四档，但同一个 `degraded` 可能是①RTT 慢 ②成功率低 ③探针不可达，
 * 三者的处置完全不同（换线路 / 查上游错误 / 查探针协议）；台账只记 tier 时，读表的人只能
 * 重新逐条翻 `details`。这与 dsfolder 门禁侧的 `reasons` 同一纪律：**状态被压平，原因就丢了**。
 *
 * 纪律：每个 provider **恰好**落一个桶（桶和恒等于 provider 数）；桶名可枚举、可 grep。
 * **冷启动（既无探针也无成功率）必须落 `cold:*`，绝不许落 `healthy:*`** ——
 * 那是"判不了冒充通过"，与本项目反复登记的反模式同族。
 */
export function healthReason(score: HealthScore): string {
  const { hasProbe, hasOutcomes, probeHealthy } = score.details;
  if (!hasProbe && !hasOutcomes) return 'cold:no-signal';
  // 探针**明确不可达**时，"不可达"是直接原因：它同时把 rttScore 拖成 0（探针没 RTT 可量），
  // 若按"加权最弱"机械比较，rtt 会赢过 unavailable 而给出误导性的原因。所以优先判它。
  if (probeHealthy === false) return `${score.tier}:unavailable`;
  return `${score.tier}:${weakestSignal(score.components)}`;
}

/** 加权后最弱（对分数拖累最大）的那一项。纯函数，仅为 `healthReason` 服务。 */
function weakestSignal(c: HealthScoreComponents): 'rtt' | 'success-rate' | 'unavailable' {
  const deficit = {
    rtt: (1 - c.rttScore) * 0.4,
    'success-rate': (1 - c.successRate) * 0.4,
    unavailable: (1 - c.availabilityScore) * 0.2,
  } as const;
  let best: keyof typeof deficit = 'rtt';
  for (const k of Object.keys(deficit) as Array<keyof typeof deficit>) {
    if (deficit[k] > deficit[best]) best = k;
  }
  return best;
}

/**
 * 按原因分桶计数。桶和 == 输入长度（`/providers/health` 里当不变量用，防"漏桶"与"重复计"）。
 * 空数组返回 `{}` —— 调用方必须把"探针还没产出分数"与"分数全是 green"分开表达，
 * 不要把空直方图当通过（见 `provider-health-route.ts` 的 `degraded`）。
 */
export function histogramByHealthReason(scores: HealthScore[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const s of scores) {
    const k = healthReason(s);
    out[k] = (out[k] ?? 0) + 1;
  }
  return out;
}


// ── In-memory score cache (filled by probe loop) ────────

const healthScoreCache = new Map<string, HealthScore>();

/** Cache a computed health score for sync consumers (fallback router). */
export function cacheHealthScore(score: HealthScore): void {
  healthScoreCache.set(score.provider, score);
}

/** Read the latest cached health score, if any. */
export function getCachedHealthScore(provider: string): HealthScore | undefined {
  return healthScoreCache.get(provider);
}

/** Read all cached health scores (for dashboards / health projection endpoints). */
export function getAllCachedHealthScores(): HealthScore[] {
  return Array.from(healthScoreCache.values());
}

/** Test-only: clear cached scores. */
export function _resetHealthScoreCacheForTests(): void {
  healthScoreCache.clear();
}

// ── Constants ───────────────────────────────────────────

/** RTT values at or above this are scored 0.0 */
const RTT_MAX_MS = 5000;

/** Weights per ADR 0043 */
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
