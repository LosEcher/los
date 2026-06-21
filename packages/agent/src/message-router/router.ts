/**
 * @los/agent/message-router/router — MessageRouter: unified inbound routing core.
 *
 * Usage:
 *   const router = new MessageRouter({ handlers: createBuiltinHandlers(deps) });
 *   const result = await router.route({ sourceKind: 'http-chat', prompt: '#status abc123' });
 */

import { normalizeInboundMessage } from './normalizer.js';
import { resolveIntent } from './intent-resolver.js';
import type {
  ChannelContext,
  HandlerContext,
  HandlerDescriptor,
  HandlerResult,
  InboundMessage,
  NormalizerInput,
  ResolvedIntent,
  RouteResult,
} from './types.js';

export interface MessageRouterOptions {
  handlers?: HandlerDescriptor[];
  channels?: ChannelContext[];
  defaultChannelId?: string;
}

export class MessageRouter {
  private handlers: HandlerDescriptor[];
  private channels: Map<string, ChannelContext>;
  private defaultChannelId: string | null;

  constructor(options: MessageRouterOptions = {}) {
    this.handlers = [...(options.handlers ?? [])];
    this.handlers.sort((a, b) => a.priority - b.priority);
    this.channels = new Map();
    for (const ch of options.channels ?? []) {
      this.channels.set(ch.id, ch);
    }
    this.defaultChannelId = options.defaultChannelId ?? null;
  }

  // ── Registration ──────────────────────────────────────────────

  /** Register a custom handler. Handlers are sorted by priority (lower = first match). */
  register(handler: HandlerDescriptor): void {
    this.handlers.push(handler);
    this.handlers.sort((a, b) => a.priority - b.priority);
  }

  /** Register a channel for outbound delivery. */
  registerChannel(ch: ChannelContext): void {
    this.channels.set(ch.id, ch);
  }

  /** Remove a channel. */
  unregisterChannel(id: string): boolean {
    return this.channels.delete(id);
  }

  // ── Routing ───────────────────────────────────────────────────

  /**
   * Main entry point: normalize → resolve intent → dispatch → deliver.
   * Returns the route result with handler output.
   */
  async route(input: NormalizerInput): Promise<RouteResult> {
    const inbound = normalizeInboundMessage(input);
    const intent = resolveIntent(inbound.rawText);
    const channel = this.resolveChannel(inbound);
    const ctx = this.buildContext(inbound, intent, channel);

    // Find first matching handler
    const handler = this.handlers.find(h => h.match(intent));
    if (!handler) {
      return { handled: false, intent, error: 'No handler matched' };
    }

    const result = await handler.handle(ctx);

    // If handler didn't reply but produced text, deliver via channel
    if (result.text && channel) {
      await channel.send(result.text).catch(() => { /* best-effort */ });
    }

    return {
      handled: result.handled,
      intent,
      text: result.text,
      sessionId: result.sessionId,
      error: result.error,
    };
  }

  /**
   * Resolve text to intent without dispatching. Useful for pre-checks
   * where the caller wants to handle dispatching themselves (e.g., SSE routes).
   */
  resolveIntent(text: string): ResolvedIntent {
    return resolveIntent(text);
  }

  /**
   * Get the handler that would handle a given intent. Returns null if none match.
   */
  findHandler(intent: ResolvedIntent): HandlerDescriptor | null {
    return this.handlers.find(h => h.match(intent)) ?? null;
  }

  // ── Internal helpers ──────────────────────────────────────────

  private resolveChannel(inbound: InboundMessage): ChannelContext | null {
    // Try exact channelId match
    const exact = this.channels.get(inbound.channelId);
    if (exact) return exact;

    // Try default
    if (this.defaultChannelId) {
      const def = this.channels.get(this.defaultChannelId);
      if (def) return def;
    }

    // Try first channel of the same kind
    for (const ch of this.channels.values()) {
      if (ch.kind === inbound.channelKind) return ch;
    }

    return null;
  }

  private buildContext(
    inbound: InboundMessage,
    intent: ResolvedIntent,
    channel: ChannelContext | null,
  ): HandlerContext {
    return {
      inbound,
      intent,
      reply: async (text, opts) => {
        if (channel) {
          await channel.send(text, opts);
        }
        // If no channel, reply is a no-op (HTTP sources handle delivery externally)
      },
    };
  }
}
