import type { TelegramUpdate } from './operator-actions.js';
import { TelegramReplayGuard } from './replay-guard.js';

interface TelegramUpdateProcessorOptions {
  handleCallback: (callback: NonNullable<TelegramUpdate['callback_query']>) => Promise<void>;
  replayGuard?: TelegramReplayGuard;
}

export function createTelegramUpdateProcessor(options: TelegramUpdateProcessorOptions) {
  const replayGuard = options.replayGuard ?? new TelegramReplayGuard();
  return async function processUpdate(update: TelegramUpdate): Promise<boolean> {
    const keys = replayKeys(update);
    return replayGuard.runOnce(keys, async () => {
      if (update.callback_query) await options.handleCallback(update.callback_query);
    });
  };
}

export async function prepareTelegramPolling(
  deleteWebhook: (options: { drop_pending_updates: false }) => Promise<unknown>,
): Promise<void> {
  const response = await deleteWebhook({ drop_pending_updates: false });
  if (!isSuccessfulTelegramResponse(response)) {
    throw new Error('Telegram deleteWebhook failed; polling cannot start while a webhook is configured');
  }
}

interface PollingLoopOptions {
  getUpdates: (offset: number) => Promise<TelegramUpdate[]>;
  processUpdate: (update: TelegramUpdate) => Promise<unknown>;
  intervalMs: number;
  signal: AbortSignal;
  wait?: (milliseconds: number) => Promise<void>;
  onError?: (error: unknown) => void;
}

export async function runTelegramPollingLoop(options: PollingLoopOptions): Promise<void> {
  const wait = options.wait ?? (milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)));
  let lastUpdateId = 0;
  while (!options.signal.aborted) {
    try {
      const updates = await options.getUpdates(lastUpdateId + 1);
      for (const update of updates) {
        await options.processUpdate(update);
        lastUpdateId = Math.max(lastUpdateId, requireUpdateId(update));
      }
    } catch (error) {
      options.onError?.(error);
    }
    if (!options.signal.aborted) await wait(options.intervalMs);
  }
}

function replayKeys(update: TelegramUpdate): string[] {
  const keys = [`update:${requireUpdateId(update)}`];
  if (update.callback_query) {
    if (!update.callback_query.id) throw new Error('Telegram callback_query.id is required');
    keys.push(`callback:${update.callback_query.id}`);
  }
  return keys;
}

function requireUpdateId(update: TelegramUpdate): number {
  if (!Number.isSafeInteger(update.update_id) || (update.update_id ?? -1) < 0) {
    throw new Error('Telegram update_id must be a non-negative safe integer');
  }
  return update.update_id!;
}

function isSuccessfulTelegramResponse(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const response = value as Record<string, unknown>;
  return response.ok === true && response.result === true;
}
