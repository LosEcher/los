/**
 * @los/agent/message-router/types — Core types for unified inbound message routing.
 *
 * Normalizes 7 distinct inbound sources into a single InboundMessage,
 * resolves intent (command dispatch vs NL chat), and provides a
 * register-based handler pattern for channel-agnostic delivery.
 *
 * Inspired by Hermes Agent's GatewayRunner._handle_message() pattern.
 */

// ── Channel kind (shared with wechat-bot Channel interface) ─────

export type ChannelKind = 'weixin' | 'web' | 'telegram' | 'direct';

// ── Source classification ────────────────────────────────────────

export type SourceKind =
  | 'http-chat'            // POST /chat
  | 'http-openai-compat'   // POST /v1/chat/completions
  | 'http-runtime'         // POST /runtimes/:kind/run
  | 'wx-weixin'            // WxPusher up-call callback
  | 'wx-web'               // Mobile web /m/exec
  | 'wx-weclaw'            // WeClaw (WeChat → OpenAI compat endpoint)
  | 'telegram';            // Telegram callback

// ── Inbound message (all sources normalize to this) ────────────

export interface InboundMessage {
  sourceKind: SourceKind;
  /** Unique ID for the originating channel instance */
  channelId: string;
  /** Channel kind (weixin, web, telegram, or direct for HTTP) */
  channelKind: ChannelKind;
  /** Extracted text from whatever format the message arrived in */
  rawText: string;
  /** Original request body / callback data, preserved for handlers */
  rawPayload: unknown;
  metadata: InboundMetadata;
}

export interface InboundMetadata {
  sessionId?: string;
  userId?: string;
  tenantId?: string;
  projectId?: string;
  /** Message ID this replies to */
  replyTo?: string;
  tags?: string[];
  traceId?: string;
  requestId?: string;
  timestamp: string;
}

// ── Intent types ─────────────────────────────────────────────────

export type ResolvedIntent =
  | { type: 'chat';       prompt: string; sessionId?: string }
  | { type: 'runtime';    kind: 'claude-code' | 'codex'; prompt: string }
  | { type: 'steering';   instruction: string; sessionId: string; turnBoundary?: 'immediate' | 'next_turn' }
  | { type: 'status';     sessionId: string }
  | { type: 'todo';       action: 'list' | 'create' | 'show'; todoId?: string; title?: string }
  | { type: 'governance'; action: 'list' | 'sweep' | 'show'; jobType?: string }
  | { type: 'unknown';    text: string };

// ── Handler pattern ──────────────────────────────────────────────

export interface HandlerContext {
  inbound: InboundMessage;
  intent: ResolvedIntent;
  /** Send text back through the originating channel */
  reply: (text: string, opts?: ReplyOptions) => Promise<void>;
  /** SSE event sender — only available for HTTP sources */
  sendEvent?: (event: string, data: unknown) => void;
}

export interface ReplyOptions {
  media?: ReplyMediaItem[];
  actions?: ReplyAction[];
  priority?: 'critical' | 'high' | 'normal' | 'low';
}

export interface ReplyMediaItem {
  type: 'image' | 'video' | 'file' | 'audio';
  url: string;
  fileName?: string;
  size?: number;
}

export interface ReplyAction {
  text: string;
  value: string;
  type?: 'primary' | 'danger' | 'default';
}

export interface HandlerDescriptor {
  name: string;
  /** Lower = higher precedence. Exact-match commands use 0-20, NL heuristics 50-90, fallback 100+. */
  priority: number;
  match: (intent: ResolvedIntent) => boolean;
  handle: (ctx: HandlerContext) => Promise<HandlerResult>;
}

export interface HandlerResult {
  handled: boolean;
  sessionId?: string;
  text?: string;
  error?: string;
}

// ── Channel context (for outbound delivery) ─────────────────────

export interface ChannelContext {
  kind: ChannelKind | 'direct';
  id: string;
  send: (text: string, opts?: ReplyOptions) => Promise<ChannelSendResult>;
}

export interface ChannelSendResult {
  ok: boolean;
  error?: string;
}

// ── Router input (union of all inbound formats) ─────────────────

export type NormalizerInput =
  | { sourceKind: 'http-chat';           prompt: string; sessionId?: string; extra?: Record<string, unknown> }
  | { sourceKind: 'http-openai-compat';  messages: Array<{ role: string; content: string }>; model?: string }
  | { sourceKind: 'http-runtime';        prompt: string; kind: string; sessionId?: string }
  | { sourceKind: 'wx-weixin';           text: string; uid?: string; metadata?: Record<string, unknown> }
  | { sourceKind: 'wx-web';              action: string; sessionId: string; callId?: string }
  | { sourceKind: 'wx-weclaw';           messages: Array<{ role: string; content: string }>; model?: string }
  | { sourceKind: 'telegram';            data: string; chatId: number };

// ── Router result ────────────────────────────────────────────────

export interface RouteResult {
  handled: boolean;
  intent: ResolvedIntent;
  text?: string;
  sessionId?: string;
  error?: string;
}
