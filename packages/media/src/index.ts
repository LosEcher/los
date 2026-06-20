/**
 * @los/media — Public API surface for media generation and delivery.
 */

export {
  getProviderCatalog,
  getProviderCatalogFlat,
  getProviderDefinition,
  resolveApiKey,
  listAvailableProviders,
  inferMediaKind,
  inferAudioMime,
  inferImageMime,
  inferVideoMime,
  type MediaKind,
  type MediaOperation,
  type MediaProviderDefinition,
  type MediaProviderCatalog,
} from './provider-catalog.js';

export {
  executeMediaOperation,
  persistMediaOutput,
  type MediaOperationInput,
  type MediaOperationResult,
  type MediaPersistResult,
  type MediaPersistOptions,
} from './media-runtime.js';

export {
  createMediaActions,
  type MediaActions,
  type MediaActionOptions,
  type TtsActionInput,
  type ImageActionInput,
  type VideoActionInput,
} from './media-actions.js';

export {
  buildTtsDeliveryReply,
  buildImageDeliveryReply,
  buildVideoDeliveryReply,
  type ChannelMediaReply,
} from './media-delivery.js';
