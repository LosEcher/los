/**
 * @los/agent/provider-health — Provider health tracking and health-aware routing.
 *
 * Inspired by Mooncake EP's fault-tolerant expert parallelism: track provider
 * "activeness" (latency, error rate, rate-limit status) and route around
 * degraded providers — analogous to Mooncake EP routing around failed ranks.
 *
 * Tracks per-provider:
 *  - Latency (exponential moving average, p50 window)
 *  - Error rate (rolling window of last N calls)
 *  - Rate-limit status (429 responses)
 *  - Circuit-breaker state (open → half-open → closed)
 */

export type ProviderHealthStatus = 'healthy' | 'degraded' | 'unavailable' | 'unknown';

export interface ProviderHealthRecord {
  provider: string;
  status: ProviderHealthStatus;
  /** Exponential moving average latency (ms). */
  emaLatencyMs: number;
  /** Error rate over the recent window (0-1). */
  errorRate: number;
  /** Consecutive failures count. */
  consecutiveFailures: number;
  /** Consecutive successes count. */
  consecutiveSuccesses: number;
  /** Whether the provider is currently rate-limited. */
  rateLimited: boolean;
  /** Timestamp of the last update. */
  lastUpdatedAt: number;
  /** Timestamp when circuit breaker opened (0 = closed). */
  circuitOpenAt: number;
  /** Total calls tracked. */
  totalCalls: number;
  /** Total errors tracked. */
  totalErrors: number;
}

export interface ProviderHealthConfig {
  /** Error rate threshold before marking degraded (default: 0.3). */
  errorRateDegradedThreshold?: number;
  /** Consecutive failures before opening circuit breaker (default: 5). */
  circuitBreakerFailures?: number;
  /** Consecutive successes in half-open state before closing (default: 2). */
  circuitBreakerRecoverySuccesses?: number;
  /** Milliseconds before attempting recovery (half-open) (default: 30_000). */
  circuitBreakerCooldownMs?: number;
  /** Window size for error rate calculation (default: 20). */
  errorRateWindowSize?: number;
  /** EMA smoothing factor for latency (default: 0.2). */
  latencyEmaAlpha?: number;
}

const DEFAULTS: Required<ProviderHealthConfig> = {
  errorRateDegradedThreshold: 0.3,
  circuitBreakerFailures: 5,
  circuitBreakerRecoverySuccesses: 2,
  circuitBreakerCooldownMs: 30_000,
  errorRateWindowSize: 20,
  latencyEmaAlpha: 0.2,
};

/** Sort providers by health score (highest first) for routing preference. */
export type ProviderHealthRanker = (providers: string[]) => string[];

export function createProviderHealthTracker(config: ProviderHealthConfig = {}) {
  const cfg = { ...DEFAULTS, ...config };
  const records = new Map<string, ProviderHealthRecord>();
  /** Sliding windows: provider → array of booleans (true = error). */
  const errorWindows = new Map<string, boolean[]>();

  function getRecord(provider: string): ProviderHealthRecord {
    let rec = records.get(provider);
    if (!rec) {
      rec = newRecord(provider);
      records.set(provider, rec);
      errorWindows.set(provider, []);
    }
    return rec;
  }

  function newRecord(provider: string): ProviderHealthRecord {
    return {
      provider,
      status: 'unknown',
      emaLatencyMs: 0,
      errorRate: 0,
      consecutiveFailures: 0,
      consecutiveSuccesses: 0,
      rateLimited: false,
      lastUpdatedAt: 0,
      circuitOpenAt: 0,
      totalCalls: 0,
      totalErrors: 0,
    };
  }

  function computeStatus(rec: ProviderHealthRecord): ProviderHealthStatus {
    // Circuit breaker open
    if (rec.circuitOpenAt > 0) {
      const elapsed = Date.now() - rec.circuitOpenAt;
      if (elapsed < cfg.circuitBreakerCooldownMs) return 'unavailable';
      // Transition to half-open: allow probe requests
      return 'degraded';
    }
    if (rec.errorRate >= cfg.errorRateDegradedThreshold) return 'degraded';
    if (rec.consecutiveFailures >= cfg.circuitBreakerFailures) return 'degraded';
    if (rec.rateLimited) return 'degraded';
    return 'healthy';
  }

  function pushErrorWindow(provider: string, isError: boolean): void {
    const window = errorWindows.get(provider) ?? [];
    window.push(isError);
    while (window.length > cfg.errorRateWindowSize) window.shift();
    errorWindows.set(provider, window);
  }

  function errorRate(provider: string): number {
    const window = errorWindows.get(provider);
    if (!window || window.length === 0) return 0;
    return window.filter(Boolean).length / window.length;
  }

  /** Record a successful provider call. */
  function recordSuccess(provider: string, latencyMs: number): void {
    const rec = getRecord(provider);
    rec.totalCalls++;
    rec.consecutiveSuccesses++;
    rec.rateLimited = false;
    rec.lastUpdatedAt = Date.now();

    // EMA latency update
    if (rec.emaLatencyMs === 0) {
      rec.emaLatencyMs = latencyMs;
    } else {
      rec.emaLatencyMs = cfg.latencyEmaAlpha * latencyMs + (1 - cfg.latencyEmaAlpha) * rec.emaLatencyMs;
    }

    pushErrorWindow(provider, false);

    // Circuit breaker recovery
    if (rec.circuitOpenAt > 0 && rec.consecutiveSuccesses >= cfg.circuitBreakerRecoverySuccesses) {
      rec.circuitOpenAt = 0;
      rec.consecutiveFailures = 0;
    } else if (rec.circuitOpenAt === 0) {
      rec.consecutiveFailures = 0;
    }

    rec.errorRate = errorRate(provider);
    rec.status = computeStatus(rec);
  }

  /** Record a failed provider call. */
  function recordError(provider: string, isRateLimit: boolean): void {
    const rec = getRecord(provider);
    rec.totalCalls++;
    rec.totalErrors++;
    rec.consecutiveFailures++;
    rec.consecutiveSuccesses = 0;
    rec.rateLimited = isRateLimit;
    rec.lastUpdatedAt = Date.now();

    pushErrorWindow(provider, true);

    // Circuit breaker trigger
    if (rec.consecutiveFailures >= cfg.circuitBreakerFailures) {
      rec.circuitOpenAt = Date.now();
    }

    rec.errorRate = errorRate(provider);
    rec.status = computeStatus(rec);
  }

  /** Check if a provider is healthy enough to receive requests. */
  function isHealthy(provider: string): boolean {
    const rec = records.get(provider);
    if (!rec) return true; // Unknown = assume healthy
    return rec.status === 'healthy';
  }

  /** Check if a provider is completely unavailable (circuit open). */
  function isUnavailable(provider: string): boolean {
    const rec = records.get(provider);
    if (!rec) return false;
    return rec.status === 'unavailable';
  }

  /**
   * Get a numeric health score for ranking (higher = better).
   * Factors: status, error rate, latency EMA.
   */
  function getHealthScore(provider: string): number {
    const rec = records.get(provider);
    if (!rec) return 100; // Unknown, assume best
    switch (rec.status) {
      case 'unavailable': return 0;
      case 'degraded': return Math.max(0, 50 - rec.errorRate * 100);
      case 'healthy': return Math.max(51, 100 - rec.errorRate * 50 - (rec.emaLatencyMs / 100));
      case 'unknown': return 100;
    }
  }

  /** Get the full health record for a provider. */
  function getHealth(provider: string): ProviderHealthRecord {
    return getRecord(provider);
  }

  /** List all tracked providers with their health status. */
  function listHealth(): ProviderHealthRecord[] {
    return [...records.values()].map(rec => ({ ...rec }));
  }

  /**
   * Rank providers by health score, excluding unavailable ones.
   * Returns providers sorted by score (best first).
   */
  function rankHealthy(providers: string[]): string[] {
    return [...providers]
      .filter(p => !isUnavailable(p))
      .sort((a, b) => getHealthScore(b) - getHealthScore(a));
  }

  /** Reset health state for a provider (e.g., after config change). */
  function reset(provider: string): void {
    records.delete(provider);
    errorWindows.delete(provider);
  }

  /** Reset all health state. */
  function resetAll(): void {
    records.clear();
    errorWindows.clear();
  }

  return {
    recordSuccess,
    recordError,
    isHealthy,
    isUnavailable,
    getHealthScore,
    getHealth,
    listHealth,
    rankHealthy,
    reset,
    resetAll,
  };
}
