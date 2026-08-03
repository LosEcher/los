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
      if (consecutiveFailures === 0) return baseIntervalMs;
      const backedOff = baseIntervalMs * backoffFactor ** consecutiveFailures;
      return Math.min(backedOff, maxBackoffMs);
    },
  };
}
