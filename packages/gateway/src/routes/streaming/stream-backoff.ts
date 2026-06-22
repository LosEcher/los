/**
 * @los/gateway/stream-backoff — Exponential backoff + jitter for SSE/WS reconnection.
 *
 * Reconnects to session streams after transient failures (connection drops,
 * lease conflicts, gateway restarts). Uses exponential backoff with jitter
 * to avoid thundering herd on the server.
 *
 * Reference: AWS Architecture Blog "Exponential Backoff And Jitter"
 */

/** Configuration for exponential backoff computation. */
export interface BackoffConfig {
  /** Initial delay in milliseconds (default: 1000). */
  baseMs?: number;
  /** Maximum delay in milliseconds (default: 120000 = 2 minutes). */
  maxMs?: number;
  /** Multiplier applied per attempt (default: 2.0). */
  factor?: number;
  /** Maximum total retry duration in milliseconds (default: 600000 = 10 minutes). */
  maxTotalMs?: number;
  /** When true, add full jitter (0 to computed delay). Default: true */
  jitter?: boolean;
}

export interface BackoffResult {
  /** Number of attempts (1-based). */
  attempt: number;
  /** Computed delay in milliseconds for this attempt. */
  delayMs: number;
  /** Cumulative time spent across all attempts, in milliseconds. */
  elapsedMs: number;
  /** When true, max total duration has been exceeded — give up. */
  shouldGiveUp: boolean;
}

const DEFAULTS: Required<BackoffConfig> = {
  baseMs: 1000,
  maxMs: 120_000,
  factor: 2.0,
  maxTotalMs: 600_000,
  jitter: true,
};

/** Stateful backoff calculator. Each call advances the attempt counter. */
export interface BackoffScheduler {
  /** Compute the next delay. Call each time a retry is triggered. */
  nextDelay(): BackoffResult;
  /** Reset attempt counter (e.g., after a successful reconnection). */
  reset(): void;
  /** Get the current state without advancing. */
  current(): BackoffResult;
}

export function createBackoffScheduler(config: BackoffConfig = {}): BackoffScheduler {
  const baseMs = config.baseMs ?? DEFAULTS.baseMs;
  const maxMs = config.maxMs ?? DEFAULTS.maxMs;
  const factor = config.factor ?? DEFAULTS.factor;
  const maxTotalMs = config.maxTotalMs ?? DEFAULTS.maxTotalMs;
  const useJitter = config.jitter ?? DEFAULTS.jitter;

  let attempt = 0;
  let elapsedMs = 0;

  function nextDelay(): BackoffResult {
    attempt++;
    let delay = baseMs * Math.pow(factor, attempt - 1);
    if (useJitter) {
      // Full jitter: random between 0 and computed delay
      delay = Math.random() * delay;
    }
    delay = Math.min(delay, maxMs);
    delay = Math.max(delay, 100); // floor at 100ms
    elapsedMs += delay;
    return {
      attempt,
      delayMs: Math.round(delay),
      elapsedMs,
      shouldGiveUp: elapsedMs >= maxTotalMs,
    };
  }

  function reset(): void {
    attempt = 0;
    elapsedMs = 0;
  }

  function current(): BackoffResult {
    const a = attempt;
    let delay = baseMs * Math.pow(factor, Math.max(0, a - 1));
    if (useJitter) delay = Math.random() * delay;
    delay = Math.min(delay, maxMs);
    delay = Math.max(delay, 100);
    return {
      attempt: a,
      delayMs: Math.round(delay),
      elapsedMs,
      shouldGiveUp: elapsedMs >= maxTotalMs,
    };
  }

  return { nextDelay, reset, current };
}

/** Exported defaults for convenience. */
export const BACKOFF_DEFAULTS = DEFAULTS;

/**
 * One-shot: compute the nth retry delay without state.
 * Useful for Server-Sent Events `retry:` field where the browser handles timing.
 */
export function computeRetryDelay(attempt: number, config: BackoffConfig = {}): number {
  const baseMs = config.baseMs ?? DEFAULTS.baseMs;
  const maxMs = config.maxMs ?? DEFAULTS.maxMs;
  const factor = config.factor ?? DEFAULTS.factor;
  const useJitter = config.jitter ?? DEFAULTS.jitter;

  let delay = baseMs * Math.pow(factor, attempt - 1);
  if (useJitter) delay = Math.random() * delay;
  delay = Math.min(delay, maxMs);
  delay = Math.max(delay, 100);
  return Math.round(delay);
}

/**
 * Format a Retry-After header value from a backoff result.
 * Returns seconds (integer) for HTTP Retry-After.
 */
export function retryAfterHeader(delayMs: number): string {
  return String(Math.max(1, Math.ceil(delayMs / 1000)));
}
