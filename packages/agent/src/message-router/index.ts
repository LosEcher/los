/**
 * @los/agent/message-router — Unified inbound message routing.
 *
 * Normalizes 7 entry points → resolves intent (commands + NL heuristics)
 * → dispatches to register-based handlers → delivers via channel.
 *
 * Inspired by Hermes Agent's GatewayRunner._handle_message().
 */

export { MessageRouter } from './router.js';
export type { MessageRouterOptions } from './router.js';

export { normalizeInboundMessage } from './normalizer.js';
export { resolveIntent } from './intent-resolver.js';

export {
  createBuiltinHandlers,
} from './handlers.js';
export type { HandlerDependencies } from './handlers.js';

export {
  createDirectChannelContext,
  createNoopChannelContext,
  createTextChannelContext,
} from './channel-adapter.js';

export type {
  ChannelContext,
  ChannelKind,
  ChannelSendResult,
  HandlerContext,
  HandlerDescriptor,
  HandlerResult,
  InboundMessage,
  InboundMetadata,
  NormalizerInput,
  ReplyAction,
  ReplyMediaItem,
  ReplyOptions,
  ResolvedIntent,
  RouteResult,
  SourceKind,
} from './types.js';
