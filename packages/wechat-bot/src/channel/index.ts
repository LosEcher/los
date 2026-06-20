/**
 * @los/wechat-bot/channel/index — Channel exports.
 */

export type {
  Channel,
  ChannelKind,
  ChannelCapabilities,
  ChannelSendResult,
  UnifiedMessage,
  MessageMedia,
  MessageAction,
  MessageTypeValue,
  MessagePriorityValue,
} from './types.js';

export { MessageType, MessagePriority } from './types.js';

export {
  createWeixinChannel,
  type WeixinChannelConfig,
  WEIXIN_CAPABILITIES,
} from './weixin.js';

export {
  createWebChannel,
  type WebChannelConfig,
} from './web.js';
