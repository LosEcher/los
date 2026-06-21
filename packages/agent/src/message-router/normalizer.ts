/**
 * @los/agent/message-router/normalizer — Normalize 7 inbound formats into unified InboundMessage.
 */

import type { InboundMessage, NormalizerInput } from './types.js';

export function normalizeInboundMessage(input: NormalizerInput): InboundMessage {
  const now = new Date().toISOString();
  const channelId = resolveChannelId(input);

  switch (input.sourceKind) {
    // ── HTTP endpoints ──────────────────────────────────────
    case 'http-chat':
      return {
        sourceKind: 'http-chat',
        channelId,
        channelKind: 'direct',
        rawText: (input.prompt ?? '').trim(),
        rawPayload: input,
        metadata: {
          sessionId: input.sessionId,
          timestamp: now,
          ...(input.extra ?? {}),
        },
      };

    case 'http-openai-compat': {
      const userMsg = (input.messages ?? [])
        .filter(m => m.role === 'user')
        .map(m => m.content)
        .join('\n');
      const systemMsg = (input.messages ?? [])
        .filter(m => m.role === 'system')
        .map(m => m.content)
        .join('\n');
      return {
        sourceKind: 'http-openai-compat',
        channelId,
        channelKind: 'direct',
        rawText: userMsg,
        rawPayload: input,
        metadata: {
          // Store system prompt as extra metadata for handler use
          sessionId: undefined,
          timestamp: now,
        },
      };
    }

    case 'http-runtime':
      return {
        sourceKind: 'http-runtime',
        channelId,
        channelKind: 'direct',
        rawText: (input.prompt ?? '').trim(),
        rawPayload: input,
        metadata: {
          sessionId: input.sessionId,
          timestamp: now,
        },
      };

    // ── WeChat channels ─────────────────────────────────────
    case 'wx-weixin':
      return {
        sourceKind: 'wx-weixin',
        channelId: `weixin-${input.uid ?? 'anon'}`,
        channelKind: 'weixin',
        rawText: (input.text ?? '').trim(),
        rawPayload: input,
        metadata: {
          sessionId: (input.metadata?.sessionId as string) ?? undefined,
          userId: input.uid,
          timestamp: now,
          tags: (input.metadata?.tags as string[]) ?? undefined,
        },
      };

    case 'wx-web':
      return {
        sourceKind: 'wx-web',
        channelId: 'web-mobile',
        channelKind: 'web',
        rawText: `${input.action} ${input.sessionId}${input.callId ? ` ${input.callId}` : ''}`,
        rawPayload: input,
        metadata: {
          sessionId: input.sessionId,
          timestamp: now,
        },
      };

    case 'wx-weclaw': {
      const wlUserMsg = (input.messages ?? [])
        .filter(m => m.role === 'user')
        .map(m => m.content)
        .join('\n');
      return {
        sourceKind: 'wx-weclaw',
        channelId: 'weclaw-direct',
        channelKind: 'direct',
        rawText: wlUserMsg,
        rawPayload: input,
        metadata: { timestamp: now },
      };
    }

    // ── Telegram ────────────────────────────────────────────
    case 'telegram':
      return {
        sourceKind: 'telegram',
        channelId: `tg-${input.chatId}`,
        channelKind: 'telegram',
        rawText: (input.data ?? '').trim(),
        rawPayload: input,
        metadata: {
          timestamp: now,
        },
      };

    default:
      // Exhaustiveness check — should never reach here
      const _exhaust: never = input;
      throw new Error(`Unknown sourceKind: ${(input as NormalizerInput).sourceKind}`);
  }
}

function resolveChannelId(input: NormalizerInput): string {
  switch (input.sourceKind) {
    case 'http-chat':          return 'http-chat';
    case 'http-openai-compat': return 'http-openai-compat';
    case 'http-runtime':       return `http-runtime-${input.kind}`;
    case 'wx-weixin':          return `weixin-${input.uid ?? 'anon'}`;
    case 'wx-web':             return 'web-mobile';
    case 'wx-weclaw':          return 'weclaw-direct';
    case 'telegram':           return `tg-${input.chatId}`;
  }
}
