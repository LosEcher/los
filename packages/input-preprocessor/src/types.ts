/**
 * @los/input-preprocessor/types — Core interfaces for the input preprocessing pipeline.
 *
 * Content flows through: detection → type-specific pipeline stages → output.
 * All stages are pure functions operating on PreprocessEntry arrays.
 */

// ---- Content Detection ----

export type ContentType = 'log' | 'code' | 'config' | 'error' | 'mixed' | 'unknown';

export interface ContentTypeDetection {
  /** Primary detected content type. */
  type: ContentType;
  /** Confidence score 0..1. Values below minConfidence trigger passthrough. */
  confidence: number;
  /** Human-readable evidence for the classification decision. */
  evidence: string[];
  /** Secondary content types detected (multi-label, e.g. log+code). */
  secondary?: ContentTypeDetection[];
}

// ---- Processing Entries ----

export interface PreprocessEntry {
  /** 0-based position in the original input. */
  index: number;
  /** The entry text (may span multiple original lines for continuations). */
  text: string;
  /** Content-based fingerprint for deduplication (set by classifier/deduplicator). */
  fingerprint?: string;
  /** Density score 0..1 from classifier. Higher = more likely noise. */
  density?: number;
  /** Extracted log level if detected. */
  level?: LogLevel;
  /** Whether this entry is part of a causal chain leading to an error. */
  isPartOfChain?: boolean;
  /** Arbitrary metadata attached by stages. */
  metadata?: Record<string, string | number | boolean>;
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'fatal' | 'trace' | 'unknown';

// ---- Safety & Audit ----

export interface SafetyReport {
  /** Total entries after tokenization. */
  totalEntries: number;
  /** Entries removed by classifier (below density threshold). */
  removedByClassifier: number;
  /** Entries merged by deduplicator. */
  deduplicatedCount: number;
  /** Entries compressed (stack-folded, field-elided, truncated). */
  compressedCount: number;
  /** Rough token estimate of original input. */
  originalTokenEstimate: number;
  /** Rough token estimate of processed output. */
  finalTokenEstimate: number;
  /** Compression ratio: finalTokens / originalTokens. Lower = more compressed. */
  compressionRatio: number;
  /** Map from backreference key to original text for removed/merged entries. */
  backreferenceMap: Record<string, string>;
  /** Warnings produced during processing. */
  warnings: string[];
}

// ---- Pipeline Composable ----

export interface StageInput {
  entries: PreprocessEntry[];
  context: StageContext;
}

export interface StageOutput {
  entries: PreprocessEntry[];
  context: StageContext;
}

export interface StageContext {
  contentType: ContentType;
  config: PreprocessorConfig;
  safety: SafetyReport;
}

// ---- Pipeline Output ----

export interface PreprocessedContent {
  /** The processed text, ready to send to the LLM. */
  processedText: string;
  /** Metadata about the preprocessing run. */
  metadata: PreprocessMetadata;
  /** Full safety report with backreferences for auditability. */
  safetyReport: SafetyReport;
}

export interface PreprocessMetadata {
  /** Primary content type detected. */
  contentType: ContentType;
  /** All content types detected (multi-label). */
  contentTypes: ContentType[];
  /** Detection confidence. */
  confidence: number;
  /** Evidence for the detection decision. */
  evidence: string[];
  /** Original input length in characters. */
  originalLength: number;
  /** Processed output length in characters. */
  processedLength: number;
  /** Rough token estimate of processed text. */
  tokenEstimate: number;
  /** Time spent in preprocessing (ms). */
  processingTimeMs: number;
}

// ---- Pipeline Input ----

export interface PreprocessorInput {
  /** Raw user input text. */
  rawText: string;
  /** Optional config overrides. Merged with defaults. */
  config?: Partial<PreprocessorConfig>;
  /** Optional hooks for audit trail and observability. */
  hooks?: PreprocessorHooks;
}

/**
 * Hooks for non-blocking side effects during preprocessing.
 * All hooks are best-effort: failures are silently ignored.
 */
export interface PreprocessorHooks {
  /** Called after preprocessing completes with metadata for audit trail. */
  onProcessed?: (event: PreprocessEvent) => void;
}

/** Event emitted after preprocessing completes. */
export interface PreprocessEvent {
  contentType: ContentType;
  contentTypes: ContentType[];
  confidence: number;
  originalLength: number;
  processedLength: number;
  tokenEstimate: number;
  compressionRatio: number;
  warnings: string[];
  processingTimeMs: number;
}

// ---- Configuration ----

export interface PreprocessorConfig {
  /** Master enable/disable switch. */
  enabled: boolean;
  /** If rawText token estimate is under this, skip processing entirely. 0 = no budget. */
  tokenBudget: number;
  /** Maximum input size in bytes. Inputs exceeding this are passed through with a warning. */
  maxInputBytes: number;
  /** Maximum number of entries after tokenization. Excess entries are truncated. */
  maxEntries: number;
  /** Minimum fraction of entries that must survive processing (0..1). */
  minRetentionRatio: number;
  /** Detection confidence below which input is passed through unchanged (0..1). */
  minConfidence: number;
  /** Log-specific denoising configuration. */
  log: LogDenoiserConfig;
}

export interface LogDenoiserConfig {
  /** Log levels treated as noise and eligible for removal. */
  noiseLevels: string[];
  /** Maximum characters for a single entry before truncation. */
  maxEntryLength: number;
  /** Density threshold above which entries are candidates for removal. */
  densityThreshold: number;
  /** JSON fields to elide from log entries during compression. */
  elideFields: string[];
  /** Enable fingerprint-based deduplication. */
  dedupFingerprint: boolean;
  /** Enable exact-match deduplication. */
  dedupExact: boolean;
  /** Number of context lines to preserve before each error. */
  contextBeforeError: number;
  /** Number of context lines to preserve after each error. */
  contextAfterError: number;
}
