/**
 * @los/input-preprocessor — Universal input preprocessing for los.
 *
 * Auto-detects content type (log, code, config, error, mixed) and applies
 * type-specific denoising before content reaches the LLM.
 *
 * P0: Core pipeline + log denoising.
 * P1: Code, config, error, mixed detectors and denoisers.
 * P2: Multi-modal (image/screenshot detection + OCR passthrough).
 */

// Public API
export { preprocessInput } from './pipeline.js';
export { resolveConfig, defaultConfig, PreprocessorConfigSchema } from './config.js';
export { createLogDetector } from './detectors/log-detector.js';
export { createErrorDetector } from './detectors/error-detector.js';
export { createCodeDetector } from './detectors/code-detector.js';
export { createConfigDetector } from './detectors/config-detector.js';
export { createMixedDetector } from './detectors/mixed-detector.js';
export { denoiseLog } from './denoisers/log-denoiser.js';
export { denoiseError } from './denoisers/error-denoiser.js';
export { denoiseCode } from './denoisers/code-denoiser.js';
export { denoiseConfig } from './denoisers/config-denoiser.js';
export { tokenizeLog, tokenizeGeneric } from './stages/tokenizer.js';
export { extractLogLevel, createClassifier } from './stages/classifier.js';
export { fingerprint, createDeduplicator } from './stages/deduplicator.js';
export {
  compressStackTrace,
  elideJsonFields,
  createCompressor,
} from './stages/compressor.js';
export {
  createSafetyReport,
  isProtectedEntry,
  validateProtectedEntries,
  maxRemovableEntries,
  buildSafetyHeader,
  shouldSkipProcessing,
  buildPassthroughOutput,
  estimateTokens,
  stripAnsi,
} from './safety.js';

// Types
export type {
  ContentType,
  ContentTypeDetection,
  PreprocessEntry,
  LogLevel,
  SafetyReport,
  StageInput,
  StageOutput,
  StageContext,
  PreprocessedContent,
  PreprocessMetadata,
  PreprocessorInput,
  PreprocessorConfig,
  LogDenoiserConfig,
  PreprocessorHooks,
  PreprocessEvent,
} from './types.js';

export type { ContentDetector } from './detectors/detector.js';
export type { PreprocessStage } from './stages/stage.js';
