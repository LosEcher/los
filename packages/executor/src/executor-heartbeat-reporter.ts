interface HeartbeatLogger {
  info(message: string): void;
  warn(message: string): void;
}

interface HeartbeatReporterOptions {
  reminderEvery?: number;
  /** Interval after a successful heartbeat (default 10s). */
  baseIntervalMs?: number;
  /** Multiplier applied to the interval per consecutive failure (default 3). */
  backoffFactor?: number;
  /** Cap for the backed-off interval (default 15m). */
  maxBackoffMs?: number;
  /**
   * Max random jitter added to the next interval (default 10% of interval, capped
   * at 2s). Spreads multi-node recovery so remotes do not stampede the gateway.
   */
  jitterMs?: number;
  /** Injected RNG for tests; defaults to Math.random. */
  random?: () => number;
}

export interface HeartbeatReporter {
  /** Send one heartbeat; counts failures and logs reminders/recovery. Never throws. */
  run(): Promise<void>;
  /** Suggested delay before the next run: base after success, exponential backoff while failing. */
  nextIntervalMs(): number;
}

function describeHeartbeatError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);

  const cause = error.cause as { code?: unknown; message?: unknown } | undefined;
  const code = typeof cause?.code === 'string' ? cause.code : undefined;
  const message = typeof cause?.message === 'string' ? cause.message : undefined;
  if (!code && !message) return error.message;

  const detail = [code, message].filter(Boolean).join(': ');
  return `${error.message} (${detail})`;
}

export function createHeartbeatReporter(
  sendHeartbeat: () => Promise<void>,
  logger: HeartbeatLogger,
  options: HeartbeatReporterOptions = {},
): HeartbeatReporter {
  const reminderEvery = options.reminderEvery ?? 60;
  const baseIntervalMs = options.baseIntervalMs ?? 10_000;
  const backoffFactor = options.backoffFactor ?? 3;
  const maxBackoffMs = options.maxBackoffMs ?? 900_000;
  const jitterMs = options.jitterMs;
  const random = options.random ?? Math.random;
  for (const [name, value] of Object.entries({
    reminderEvery,
    baseIntervalMs,
    backoffFactor,
    maxBackoffMs,
  })) {
    if (!Number.isInteger(value) || value < 1) {
      throw new Error(`${name} must be a positive integer`);
    }
  }
  if (jitterMs !== undefined && (!Number.isInteger(jitterMs) || jitterMs < 0)) {
    throw new Error('jitterMs must be a non-negative integer');
  }

  let consecutiveFailures = 0;

  return {
    async run() {
      try {
        await sendHeartbeat();
        if (consecutiveFailures > 0) {
          logger.info(`node heartbeat recovered after ${consecutiveFailures} consecutive failures`);
          consecutiveFailures = 0;
        }
      } catch (error) {
        consecutiveFailures += 1;
        if (consecutiveFailures === 1 || consecutiveFailures % reminderEvery === 0) {
          logger.warn(
            `node heartbeat failed (${consecutiveFailures} consecutive): ${describeHeartbeatError(error)}`,
          );
        }
      }
    },
    nextIntervalMs() {
      const raw = consecutiveFailures === 0
        ? baseIntervalMs
        : Math.min(baseIntervalMs * backoffFactor ** consecutiveFailures, maxBackoffMs);
      const maxJitter = jitterMs ?? Math.min(2_000, Math.floor(raw * 0.1));
      if (maxJitter <= 0) return raw;
      // random() may be 0..1 inclusive in tests; clamp so jitter stays in [0, maxJitter].
      const unit = Math.min(1, Math.max(0, random()));
      return raw + Math.round(unit * maxJitter);
    },
  };
}
