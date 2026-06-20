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
  /** Callback when WARN level is reached */
  onWarn?: (state: ContextFillState) => void;
  /** Callback when CHECKPOINT level is reached (fires once per threshold crossing) */
  onCheckpoint?: (state: ContextFillState) => void;
  /** Callback when CRITICAL level is reached (fires once per threshold crossing) */
  onCritical?: (state: ContextFillState) => void;
  /** Callback on every fill change (for telemetry) */
  onFillChange?: (state: ContextFillState) => void;
}

export interface ContextFillState {
  /** Current estimated token usage */
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
  /** Cumulative prompt tokens from API usage data */
  cumulativePromptTokens: number;
  /** Cumulative completion tokens */
  cumulativeCompletionTokens: number;
  /** Estimated total message tokens (prompt + completion + message overhead) */
  estimatedTotalTokens: number;
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
  let cumulativePrompt = 0;
  let cumulativeCompletion = 0;
  let estimatedMessageTokens = 0;

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
   * Update the monitor with the latest API usage data.
   * Call after each model turn.
   */
  function update(
    usage: {
      promptTokens: number;
      completionTokens: number;
      cacheHitTokens?: number;
      cacheMissTokens?: number;
    },
    turn: number,
    /** Optional: known message count to add overhead estimate (~3 tokens/msg) */
    messageCount?: number,
  ): ContextFillState {
    cumulativePrompt += usage.promptTokens;
    cumulativeCompletion += usage.completionTokens;

    // Message overhead: system + tools + ~3 tokens/msg for roles
    const msgOverhead = messageCount ? messageCount * 3 : 0;
    estimatedMessageTokens = cumulativePrompt + cumulativeCompletion + msgOverhead;

    // Tool result tokens are already counted in promptTokens via API,
    // so estimatedMessageTokens includes them.
    const usedTokens = estimatedMessageTokens;
    const fillPercent = usedTokens / ctxWindow;

    const level = determineLevel(fillPercent);
    const newCrossing = isNewCrossing(level);
    if (newCrossing) markCrossed(level);

    const state: ContextFillState = {
      usedTokens,
      contextWindowTokens: ctxWindow,
      fillPercent: Math.min(fillPercent, 1.0),
      level,
      levelCrossed: newCrossing,
      turn,
      cumulativePromptTokens: cumulativePrompt,
      cumulativeCompletionTokens: cumulativeCompletion,
      estimatedTotalTokens: usedTokens,
    };

    // Fire callbacks
    config.onFillChange?.(state);

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
    cumulativePrompt = 0;
    cumulativeCompletion = 0;
    estimatedMessageTokens = 0;
  }

  /** Get current state without updating */
  function getState(): Omit<ContextFillState, 'levelCrossed' | 'turn'> {
    const fillPercent = estimatedMessageTokens / ctxWindow;
    return {
      usedTokens: estimatedMessageTokens,
      contextWindowTokens: ctxWindow,
      fillPercent: Math.min(fillPercent, 1.0),
      level: determineLevel(fillPercent),
      cumulativePromptTokens: cumulativePrompt,
      cumulativeCompletionTokens: cumulativeCompletion,
      estimatedTotalTokens: estimatedMessageTokens,
    };
  }

  /** Format fill state as a human-readable string */
  function formatState(state: ContextFillState): string {
    const pct = (state.fillPercent * 100).toFixed(1);
    const levelIcon = {
      normal: '○',
      warn: '⚠',
      checkpoint: '◈',
      critical: '🛑',
    }[state.level];
    return `${levelIcon} [${state.level.toUpperCase()}] Turn ${state.turn}: ${state.usedTokens.toLocaleString()} / ${state.contextWindowTokens.toLocaleString()} tokens (${pct}%)`;
  }

  return { update, reset, getState, formatState, config: { ctxWindow, warnThresh, checkpointThresh, criticalThresh } };
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
  return `${levelIcon} [${state.level.toUpperCase()}] Turn ${state.turn}: ${state.usedTokens.toLocaleString()} / ${state.contextWindowTokens.toLocaleString()} tokens (${pct}%)`;
}
