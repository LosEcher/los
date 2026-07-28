interface HeartbeatLogger {
  info(message: string): void;
  warn(message: string): void;
}

interface HeartbeatReporterOptions {
  reminderEvery?: number;
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
): () => Promise<void> {
  const reminderEvery = options.reminderEvery ?? 60;
  if (!Number.isInteger(reminderEvery) || reminderEvery < 1) {
    throw new Error('reminderEvery must be a positive integer');
  }

  let consecutiveFailures = 0;

  return async () => {
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
  };
}
