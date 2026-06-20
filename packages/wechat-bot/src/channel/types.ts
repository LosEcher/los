/**
 * @los/wechat-bot/channel/types — Channel abstraction layer.
 *
 * Inspired by lsclaw's src/channels/types.mjs Channel class and
 * message-bus.mjs MessageBus. Separates channel implementation from
 * event consumption and message formatting.
 *
 * Channels: weixin (WxPusher), web (mobile dashboard), telegram (optional)
 */

export type ChannelKind = 'weixin' | 'web' | 'telegram';

export const MessageType = Object.freeze({
  TEXT: 'text' as const,
  IMAGE: 'image' as const,
  FILE: 'file' as const,
  VIDEO: 'video' as const,
  AUDIO: 'audio' as const,
  CARD: 'card' as const,
  SYSTEM: 'system' as const,
  COMMAND: 'command' as const,
});

export type MessageTypeValue = typeof MessageType[keyof typeof MessageType] | string;

export const MessagePriority = Object.freeze({
  CRITICAL: 'critical' as const,
  HIGH: 'high' as const,
  NORMAL: 'normal' as const,
  LOW: 'low' as const,
});

export type MessagePriorityValue = typeof MessagePriority[keyof typeof MessagePriority] | string;

export interface MessageMedia {
  type: 'image' | 'video' | 'audio' | 'file';
  url: string;
  mimeType?: string;
  size?: number;
  fileName?: string;
  thumbnailUrl?: string;
  durationSec?: number;
}

export interface MessageAction {
  text: string;
  value: string;
  type?: 'primary' | 'danger' | 'default';
}

export interface UnifiedMessage {
  id: string;
  type: MessageTypeValue;
  version: '1.0';

  text: string;
  summary?: string;

  /** Multi-media attachments (image/video/audio/file) */
  media?: MessageMedia;
  /** Multiple media items for batch delivery */
  mediaList?: MessageMedia[];

  /** Interactive action buttons */
  actions?: MessageAction[];

  routing: {
    priority: MessagePriorityValue;
    /** Target user/channel recipient ID */
    recipient: string | null;
    /** Message this replies to */
    replyTo: string | null;
    /** Channel to deliver through */
    channel: ChannelKind;
  };

  metadata: {
    timestamp: string;
    source: string;
    channel: ChannelKind;
    sessionId?: string;
    taskRunId?: string;
    traceId?: string;
    tags?: string[];
    [key: string]: unknown;
  };

  /** Internal tracking */
  _internal: {
    standardizedAt: string;
    compressed: boolean;
    size: number;
  };
}

export interface ChannelCapabilities {
  /** Text support */
  text: boolean;
  /** Image delivery support */
  image: boolean;
  /** Video delivery support */
  video: boolean;
  /** Audio/file delivery support */
  file: boolean;
  /** Interactive buttons/actions support */
  actions: boolean;
  /** HTML/Markdown rich text support */
  richText: boolean;
  /** Up-call / inbound command support */
  upCall: boolean;
  /** Mobile-optimized web view support */
  mobileWeb: boolean;
  /** Max message length (chars) */
  maxTextLength: number;
  /** Max media size (bytes) */
  maxMediaSize: number;
}

export interface ChannelSendResult {
  ok: boolean;
  messageId?: string;
  error?: string;
  channel: ChannelKind;
}

export interface Channel {
  kind: ChannelKind;
  capabilities: ChannelCapabilities;

  /** Send a unified message through this channel */
  send(message: UnifiedMessage): Promise<ChannelSendResult>;

  /** Send a card/action message */
  sendCard(message: UnifiedMessage): Promise<ChannelSendResult>;

  /** Register inbound message handler. Returns unsubscribe function. */
  onMessage(handler: (message: UnifiedMessage) => void | Promise<void>): () => void;

  /** Health check */
  health(): Promise<{ healthy: boolean; message: string }>;

  /** Start the channel */
  start(): Promise<{ ok: boolean }>;

  /** Stop the channel */
  stop(): Promise<{ ok: boolean }>;
}
