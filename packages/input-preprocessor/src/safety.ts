/**
 * @los/input-preprocessor/safety — Safety guards and invariants for the preprocessing pipeline.
 *
 * Non-negotiable rules:
 * 1. ERROR/FATAL entries are NEVER removed (hard-coded, not configurable).
 * 2. Low-confidence detection → passthrough (return raw input unchanged).
 * 3. Backreference map tracks every removed/merged entry.
 * 4. Minimum retention ratio is enforced — at least minRetentionRatio entries survive.
 * 5. Multi-line entries are never split (structural integrity enforced by tokenizer).
 * 6. Causal chain: entries before/after errors are preserved.
 * 7. Safety header is prepended so the LLM knows what was filtered.
 */

import type { PreprocessEntry, PreprocessorConfig, SafetyReport } from './types.js';
import type { ContentType } from './types.js';
import { estimateTokens } from './token-utils.js';

// ---- Safety Report Factory ----

export function createSafetyReport(): SafetyReport {
  return {
    totalEntries: 0,
    removedByClassifier: 0,
    deduplicatedCount: 0,
    compressedCount: 0,
    originalTokenEstimate: 0,
    finalTokenEstimate: 0,
    compressionRatio: 1,
    backreferenceMap: {},
    warnings: [],
  };
}

// ---- Core Invariants ----

/** ERROR and FATAL levels that must never be removed. */
const PROTECTED_LEVELS = new Set(['error', 'fatal']);

/**
 * Check whether an entry has a protected log level.
 * Returns true for ERROR and FATAL — these are NEVER eligible for removal.
 */
export function isProtectedEntry(entry: PreprocessEntry): boolean {
  return entry.level !== undefined && PROTECTED_LEVELS.has(entry.level);
}

/**
 * Validate that no protected entries were removed.
 * Returns violations found (empty = safe).
 */
export function validateProtectedEntries(
  before: PreprocessEntry[],
  after: PreprocessEntry[],
): string[] {
  const violations: string[] = [];
  const afterIndices = new Set(after.map(e => e.index));

  for (const entry of before) {
    if (isProtectedEntry(entry) && !afterIndices.has(entry.index)) {
      violations.push(
        `SAFETY VIOLATION: Protected entry (level=${entry.level}, index=${entry.index}) was removed. ` +
        `Content: "${entry.text.slice(0, 120)}"`,
      );
    }
  }
  return violations;
}

// ---- Retention Ratio Enforcement ----

/**
 * Enforce minimum retention ratio. If removing more entries would drop below
 * the threshold, stop and preserve remaining entries.
 *
 * Returns the maximum number of entries that can be removed while maintaining
 * the configured minRetentionRatio.
 */
export function maxRemovableEntries(
  totalEntries: number,
  alreadyRemoved: number,
  config: PreprocessorConfig,
): number {
  const minKeep = Math.ceil(totalEntries * config.minRetentionRatio);
  const keptSoFar = totalEntries - alreadyRemoved;
  return Math.max(0, keptSoFar - minKeep);
}

// ---- Backreference Tracking ----

let _backrefCounter = 0;

export function resetBackrefCounter(): void {
  _backrefCounter = 0;
}

export function nextBackrefKey(prefix: string): string {
  return `${prefix}:${_backrefCounter++}`;
}

// ---- Safety Header ----

/**
 * Build a safety header that informs the LLM about what preprocessing was applied.
 * This is prepended to the processed text so the model knows the context.
 */
export function buildSafetyHeader(report: SafetyReport, contentType: ContentType): string {
  const parts: string[] = [
    `[Input preprocessed: ${contentType} content`,
  ];

  if (report.removedByClassifier > 0) {
    parts.push(`${report.removedByClassifier} low-signal entries filtered`);
  }
  if (report.deduplicatedCount > 0) {
    parts.push(`${report.deduplicatedCount} duplicates merged`);
  }
  if (report.compressedCount > 0) {
    parts.push(`${report.compressedCount} entries compressed`);
  }

  const reduction = Math.round((1 - report.compressionRatio) * 100);
  parts.push(`${reduction}% token reduction`);

  if (report.warnings.length > 0) {
    parts.push(`${report.warnings.length} warnings`);
  }

  parts.push(']');
  return parts.join(', ');
}

// ---- Input Validation ----

/**
 * Check if preprocessing should be skipped entirely.
 * Returns reason string if skipped, null if processing should proceed.
 *
 * Guards (in order):
 * 1. Disabled by config
 * 2. Empty/whitespace-only input
 * 3. Mini-input: short conversational text with no newlines (< 50 chars)
 * 4. Binary content: null bytes or high ratio of non-printable characters
 * 5. Oversized input: exceeds maxInputBytes
 * 6. Within token budget
 */
export function shouldSkipProcessing(
  rawText: string,
  config: PreprocessorConfig,
): string | null {
  if (!config.enabled) return 'preprocessing disabled by config';

  if (!rawText || rawText.trim().length === 0) return 'empty input';

  // Binary detection: null bytes indicate non-text content.
  // Must check BEFORE mini-input guard — null bytes can appear in short strings.
  if (rawText.includes('\0')) {
    return 'binary content detected (null bytes), skipping preprocessing';
  }

  // Non-printable character ratio check.
  const nonPrintableRatio = computeNonPrintableRatio(rawText);
  if (nonPrintableRatio > 0.3) {
    return `high non-printable ratio (${Math.round(nonPrintableRatio * 100)}%), likely binary`;
  }

  // Mini-input guard: short single-line text is conversational, not preprocessable.
  // Under 50 chars with no newlines → almost certainly "继续", "ok", "?", etc.
  if (!rawText.includes('\n') && rawText.length < 50) {
    return `mini-input (${rawText.length} chars, conversational)`;
  }

  // Input size guard: prevent OOM on oversized pastes.
  const byteLength = Buffer.byteLength(rawText, 'utf-8');
  if (byteLength > config.maxInputBytes) {
    const mb = Math.round(byteLength / 1_048_576);
    const limitMb = Math.round(config.maxInputBytes / 1_048_576);
    return `input too large (${mb}MB > ${limitMb}MB limit)`;
  }

  const tokens = estimateTokens(rawText);
  if (config.tokenBudget > 0 && tokens <= config.tokenBudget) {
    return `input within token budget (${tokens} <= ${config.tokenBudget})`;
  }

  return null;
}

/**
 * Compute the ratio of non-printable characters in a string.
 * Printable: \n, \r, \t, and characters 0x20-0x7e, plus common Unicode.
 */
function computeNonPrintableRatio(text: string): number {
  if (text.length === 0) return 0;
  const sample = text.slice(0, 1000); // Sample first 1000 chars for performance.
  let nonPrintable = 0;
  for (const ch of sample) {
    const code = ch.codePointAt(0) ?? 0;
    // Allow: tab, newline, carriage return, space through ~, and Unicode above Latin-1.
    if (code === 9 || code === 10 || code === 13) continue;
    if (code >= 0x20 && code <= 0x7e) continue;
    if (code >= 0x80) continue; // Unicode (CJK, emoji, etc.)
    nonPrintable++;
  }
  return nonPrintable / sample.length;
}

// ---- Passthrough Output ----

/**
 * Build a passthrough PreprocessedContent when processing is skipped.
 */
export function buildPassthroughOutput(
  rawText: string,
  reason: string,
  contentType: ContentType,
): {
  processedText: string;
  metadata: {
    contentType: ContentType;
    contentTypes: ContentType[];
    confidence: number;
    evidence: string[];
    originalLength: number;
    processedLength: number;
    tokenEstimate: number;
    processingTimeMs: number;
  };
  safetyReport: SafetyReport;
} {
  const report = createSafetyReport();
  report.originalTokenEstimate = estimateTokens(rawText);
  report.finalTokenEstimate = report.originalTokenEstimate;
  report.totalEntries = rawText.split('\n').filter(Boolean).length;

  return {
    processedText: rawText,
    metadata: {
      contentType,
      contentTypes: [contentType],
      confidence: 0,
      evidence: [reason],
      originalLength: rawText.length,
      processedLength: rawText.length,
      tokenEstimate: report.finalTokenEstimate,
      processingTimeMs: 0,
    },
    safetyReport: report,
  };
}

/**
 * Re-export token estimator for use by stages.
 * Simple chars/4 heuristic with non-ASCII penalty (±15% accuracy).
 */
export { estimateTokens };

// ---- ANSI Escape Code Stripping ----

/**
 * Strip ANSI escape codes (SGR, CSI, OSC) from terminal-colored text.
 * Handles the most common patterns from CI logs, terminal dumps, and colored output.
 *
 * Patterns covered:
 * - CSI (Control Sequence Introducer): ESC [ params (A-Z|a-z)
 * - SGR (Select Graphic Rendition): ESC [ params m
 * - OSC (Operating System Command): ESC ] ... (BEL|ST)
 * - Cursor/erase sequences: ESC [ params (H|f|J|K)
 *
 * This is called BEFORE content detection so classifiers see clean text.
 */
export function stripAnsi(text: string): string {
  // Fast path: no ESC character present.
  if (text.indexOf('\x1b') === -1 && text.indexOf('') === -1) return text;

  return (
    text
      // OSC sequences: ESC ] ... (BEL | ST)
      // eslint-disable-next-line no-control-regex
      .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
      // CSI sequences: ESC [ params (letter)
      // eslint-disable-next-line no-control-regex
      .replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')
      // Lone ESC followed by non-CSI control (cursor save/restore, etc.)
      // eslint-disable-next-line no-control-regex
      .replace(/\x1b[78DEHM]/g, '')
  );
}
