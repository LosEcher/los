/**
 * chat-stream-persist — Fire-and-forget stream checkpoint persistence.
 *
 * Thin wrapper around createStreamCheckpoint used by chat callbacks.
 */

import { createStreamCheckpoint } from '@los/agent/stream-checkpoints';

export async function persistStreamCheckpoint(opts: {
  sessionId: string;
  runSpecId?: string;
  eventType: string;
  turn?: number;
  payload?: Record<string, unknown>;
}): Promise<void> {
  await createStreamCheckpoint({
    sessionId: opts.sessionId,
    runSpecId: opts.runSpecId,
    turn: opts.turn ?? 0,
    eventType: opts.eventType,
    payload: opts.payload ?? {},
  });
}
