/**
 * @los/agent/message-router/channel-adapter — Adapt external Channel to router ChannelContext.
 *
 * Bridges wechat-bot's Channel interface (with UnifiedMessage, ChannelSendResult)
 * to the router's ChannelContext (plain text + ReplyOptions). Also provides
 * a direct adapter for HTTP endpoints that don't go through a Channel.
 */

import type {
  ChannelContext,
  ChannelKind,
  ChannelSendResult,
  ReplyOptions,
} from './types.js';

// ── Direct adapter (HTTP endpoints) ──────────────────────────────

/**
 * Create a simple in-memory channel context for HTTP endpoints.
 * Calls `sendFn` directly — no message formatting, no channel routing.
 */
export function createDirectChannelContext(
  sendFn: (text: string, opts?: ReplyOptions) => void,
): ChannelContext {
  return {
    kind: 'direct',
    id: 'direct-http',
    send: async (text, opts) => {
      try {
        sendFn(text, opts);
        return { ok: true };
      } catch (err) {
        return { ok: false, error: (err as Error).message };
      }
    },
  };
}

// ── No-op adapter (for testing / no-delivery contexts) ──────────

export function createNoopChannelContext(): ChannelContext {
  return {
    kind: 'direct',
    id: 'noop',
    send: async () => ({ ok: true }),
  };
}

// ── Generic text-send adapter ────────────────────────────────────

/**
 * Create a channel context from a generic async text-send function.
 * Useful for bot processes that need to reply through platform APIs.
 */
export function createTextChannelContext(
  kind: ChannelKind,
  id: string,
  sendFn: (text: string) => Promise<{ ok: boolean; error?: string }>,
): ChannelContext {
  return {
    kind,
    id,
    send: async (text, _opts) => {
      return sendFn(text);
    },
  };
}
