/**
 * @los/agent/context-monitor — Context window fill % tracking with 3-tier thresholds.
 *
 * Monitors token usage against the model's context window after each turn.
 * Three thresholds (configurable):
 *   60% → WARN  — log warning, prefer targeted file reads
 *   75% → CHECKPOINT — persist session state before potential degradation
 *   85% → CRITICAL — trigger compaction / session handoff
 *
 * Reference:
 *   - Anthropic effective context engineering guide
 *   - Zylos Research: AI Agent Context Window Management 2026
 *   - JetBrains Research: SWE-bench compaction study Dec 2025
 *   - arXiv:2606.11213 CWL: Structured Context Eviction
 */

export interface ContextMonitorConfig {
  /** Model's advertised context window size (tokens). Default: 200000 */
  contextWindowTokens?: number;
  /** Warn threshold (0-1). Default: 0.60 */
  warnThreshold?: number;
  /** Checkpoint threshold (0-1). Default: 0.75 */
  checkpointThreshold?: number;
  /** Critical / compact threshold (0-1). Default: 0.85 */
  criticalThreshold?: number;
  /** Cache hit rate that triggers a low-cache warning (0-1). Default: 0.70 */
  cacheHitRateWarnThreshold?: number;
  /** Callback when WARN level is reached */
  onWarn?: (state: ContextFillState) => void;
  /** Callback when CHECKPOINT level is reached (fires once per threshold crossing) */
  onCheckpoint?: (state: ContextFillState) => void;
  /** Callback when CRITICAL level is reached (fires once per threshold crossing) */
  onCritical?: (state: ContextFillState) => void;
  /** Callback on every fill change (for telemetry) */
  onFillChange?: (state: ContextFillState) => void;
  /** Callback when cache hit rate drops below cacheHitRateWarnThreshold */
  onCacheLow?: (state: ContextFillState) => void;
}

export interface ContextFillState {
  /** Current context usage from the latest provider response */
  usedTokens: number;
  /** Maximum context window tokens */
  contextWindowTokens: number;
  /** Fill percentage 0-1 */
  fillPercent: number;
  /** Current threshold level */
  level: ContextFillLevel;
  /** Has this level already been crossed? (prevents repeated callbacks) */
  levelCrossed: boolean;
  /** Turn number */
  turn: number;
  /** Latest turn prompt tokens (provider-reported, includes full context for chat APIs) */
  latestPromptTokens: number;
  /** Cumulative completion tokens across all turns (completions are per-turn incremental) */
  cumulativeCompletionTokens: number;
  /** Current estimated context tokens (latest prompt + completion, or provider total) */
  estimatedTotalTokens: number;
  /** Rolling cache hit rate (0-1), or undefined if no cache events observed */
  cacheHitRate: number | undefined;
  /** Whether any cache activity has been observed across turns */
  cacheObserved: boolean;
  /** Cumulative cache hit tokens across all turns */
  cumulativeCacheHitTokens: number;
  /** Cumulative cache miss tokens across all turns */
  cumulativeCacheMissTokens: number;
}

export type ContextFillLevel = 'normal' | 'warn' | 'checkpoint' | 'critical';

const DEFAULTS = {
  contextWindowTokens: 200_000,
  warnThreshold: 0.60,
  checkpointThreshold: 0.75,
  criticalThreshold: 0.85,
} as const;

interface CrossedLevels {
  warn: boolean;
  checkpoint: boolean;
  critical: boolean;
}

/**
 * Monitors context window fill across agent turns.
 *
 * Usage in loop.ts:
 *   const monitor = createContextMonitor({ contextWindowTokens: 200000 });
 *   for (turn of turns) {
 *     const state = monitor.update(res.usage, turn);
 *     if (state.level === 'critical') break; // or trigger compaction
 *   }
 */
export function createContextMonitor(config: ContextMonitorConfig = {}) {
  const ctxWindow = config.contextWindowTokens ?? DEFAULTS.contextWindowTokens;
  const warnThresh = config.warnThreshold ?? DEFAULTS.warnThreshold;
  const checkpointThresh = config.checkpointThreshold ?? DEFAULTS.checkpointThreshold;
  const criticalThresh = config.criticalThreshold ?? DEFAULTS.criticalThreshold;

  const crossed: CrossedLevels = { warn: false, checkpoint: false, critical: false };
  let crossedCacheLow = false;
  let latestPrompt = 0;
  let cumulativeCompletion = 0;
  let currentContextTokens = 0;
  let cumulativeCacheHit = 0;
  let cumulativeCacheMiss = 0;

  function determineLevel(fillPercent: number): ContextFillLevel {
    if (fillPercent >= criticalThresh) return 'critical';
    if (fillPercent >= checkpointThresh) return 'checkpoint';
    if (fillPercent >= warnThresh) return 'warn';
    return 'normal';
  }

  function isNewCrossing(level: ContextFillLevel): boolean {
    if (level === 'critical' && !crossed.critical) return true;
    if (level === 'checkpoint' && !crossed.checkpoint && !crossed.critical) return true;
    if (level === 'warn' && !crossed.warn && !crossed.checkpoint && !crossed.critical) return true;
    return false;
  }

  function markCrossed(level: ContextFillLevel): void {
    if (level === 'critical') crossed.critical = true;
    if (level === 'checkpoint') crossed.checkpoint = true;
    if (level === 'warn') crossed.warn = true;
  }

  /**
   * Record cache activity to compute rolling hit rate.
   * Call after each model turn alongside update().
   */
  function recordCacheActivity(hitTokens: number, missTokens: number): void {
    cumulativeCacheHit += normalizeTokenCount(hitTokens);
    cumulativeCacheMiss += normalizeTokenCount(missTokens);
  }

  /** Compute current cache hit rate from accumulated token counts */
  function computeCacheHitRate(): number | undefined {
    const total = cumulativeCacheHit + cumulativeCacheMiss;
    if (total === 0) return undefined;
    return cumulativeCacheHit / total;
  }

  /**
   * Update the monitor with the latest API usage data.
   * Call after each model turn.
   */
  function update(
    usage: {
      promptTokens: number;
      completionTokens: number;
      cacheHitTokens?: number;
      cacheMissTokens?: number;
      totalTokens?: number;
    },
    turn: number,
    /** Optional: known message count to add overhead estimate (~3 tokens/msg) */
    messageCount?: number,
  ): ContextFillState {
    const promptTokens = normalizeTokenCount(usage.promptTokens);
    const completionTokens = normalizeTokenCount(usage.completionTokens);
    // Chat APIs report full prompt tokens per request (including history),
    // so accumulate only completions and track the latest prompt directly.
    latestPrompt = promptTokens;
    cumulativeCompletion += completionTokens;

    const reportedTotal = normalizeOptionalTokenCount(usage.totalTokens);
    // Current context: provider total if available, otherwise prompt + completion from latest turn.
    const providerContextTokens = reportedTotal ?? promptTokens + completionTokens;
    const fallbackOverhead = providerContextTokens === 0 && messageCount
      ? messageCount * 3
      : 0;
    currentContextTokens = providerContextTokens + fallbackOverhead;

    const usedTokens = currentContextTokens;
    const fillPercent = usedTokens / ctxWindow;

    const level = determineLevel(fillPercent);
    const newCrossing = isNewCrossing(level);
    if (newCrossing) markCrossed(level);

    const cacheHitRate = computeCacheHitRate();
    const state: ContextFillState = {
      usedTokens,
      contextWindowTokens: ctxWindow,
      fillPercent: Math.min(fillPercent, 1.0),
      level,
      levelCrossed: newCrossing,
      turn,
      latestPromptTokens: latestPrompt,
      cumulativeCompletionTokens: cumulativeCompletion,
      estimatedTotalTokens: usedTokens,
      cacheHitRate,
      cacheObserved: cumulativeCacheHit + cumulativeCacheMiss > 0,
      cumulativeCacheHitTokens: cumulativeCacheHit,
      cumulativeCacheMissTokens: cumulativeCacheMiss,
    };

    // Fire callbacks
    config.onFillChange?.(state);

    // Cache hit rate warning (fires once per low-cache crossing)
    const cacheLowThreshold = config.cacheHitRateWarnThreshold ?? 0.70;
    if (cacheHitRate !== undefined && cacheHitRate < cacheLowThreshold && !crossedCacheLow) {
      crossedCacheLow = true;
      config.onCacheLow?.(state);
    }
    // Reset cache-low crossing when hit rate recovers above threshold
    if (cacheHitRate !== undefined && cacheHitRate >= cacheLowThreshold && crossedCacheLow) {
      crossedCacheLow = false;
    }

    if (newCrossing) {
      switch (level) {
        case 'warn':
          config.onWarn?.(state);
          break;
        case 'checkpoint':
          config.onCheckpoint?.(state);
          break;
        case 'critical':
          config.onCritical?.(state);
          break;
      }
    }

    return state;
  }

  /** Reset all state (e.g., after compaction) */
  function reset(): void {
    crossed.warn = false;
    crossed.checkpoint = false;
    crossed.critical = false;
    crossedCacheLow = false;
    latestPrompt = 0;
    cumulativeCompletion = 0;
    currentContextTokens = 0;
    cumulativeCacheHit = 0;
    cumulativeCacheMiss = 0;
  }

  /** Get current state without updating */
  function getState(): Omit<ContextFillState, 'levelCrossed' | 'turn'> {
    const fillPercent = currentContextTokens / ctxWindow;
    const cacheHitRate = computeCacheHitRate();
    return {
      usedTokens: currentContextTokens,
      contextWindowTokens: ctxWindow,
      fillPercent: Math.min(fillPercent, 1.0),
      level: determineLevel(fillPercent),
      latestPromptTokens: latestPrompt,
      cumulativeCompletionTokens: cumulativeCompletion,
      estimatedTotalTokens: currentContextTokens,
      cacheHitRate,
      cacheObserved: cumulativeCacheHit + cumulativeCacheMiss > 0,
      cumulativeCacheHitTokens: cumulativeCacheHit,
      cumulativeCacheMissTokens: cumulativeCacheMiss,
    };
  }

  /** Format fill state as a human-readable string */
  function formatState(state: ContextFillState): string {
    return formatContextFill(state);
  }

  return { update, reset, getState, formatState, recordCacheActivity, config: { ctxWindow, warnThresh, checkpointThresh, criticalThresh } };
}

function normalizeTokenCount(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function normalizeOptionalTokenCount(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value) || value < 0) return undefined;
  return value;
}

/** Convenience export for formatting without a monitor instance */
export function formatContextFill(state: ContextFillState): string {
  const pct = (state.fillPercent * 100).toFixed(1);
  const levelIcon = {
    normal: '○',
    warn: '⚠',
    checkpoint: '◈',
    critical: '🛑',
  }[state.level];
  const cacheInfo = state.cacheObserved
    ? ` cache:${((state.cacheHitRate ?? 0) * 100).toFixed(0)}%`
    : '';
  return `${levelIcon} [${state.level.toUpperCase()}] Turn ${state.turn}: ${state.usedTokens.toLocaleString()} / ${state.contextWindowTokens.toLocaleString()} tokens (${pct}%)${cacheInfo}`;
}
