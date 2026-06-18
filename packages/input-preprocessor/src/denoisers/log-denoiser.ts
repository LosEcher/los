/**
 * @los/input-preprocessor/denoisers/log-denoiser — Log content denoising pipeline.
 *
 * Assembles the full log processing chain:
 *   Tokenizer → Classifier → Deduplicator → Compressor
 *
 * Handles:
 * - Causal chain preservation (keep context around errors)
 * - Density-based filtering (remove low-signal entries)
 * - Safety invariant enforcement (ERROR/FATAL never removed)
 */

import type {
  PreprocessEntry,
  PreprocessorConfig,
  SafetyReport,
  StageContext,
} from '../types.js';
import { tokenizeLog } from '../stages/tokenizer.js';
import { createClassifier } from '../stages/classifier.js';
import { createDeduplicator } from '../stages/deduplicator.js';
import { createCompressor } from '../stages/compressor.js';
import {
  isProtectedEntry,
  validateProtectedEntries,
  maxRemovableEntries,
  nextBackrefKey,
  resetBackrefCounter,
  estimateTokens,
} from '../safety.js';

/**
 * Run the full log denoising pipeline on raw log text.
 * Returns processed entries and updated safety report.
 */
export function denoiseLog(
  rawText: string,
  config: PreprocessorConfig,
  safety: SafetyReport,
): { processedText: string; safety: SafetyReport } {
  resetBackrefCounter();

  // Stage 0: Tokenize.
  let entries = tokenizeLog(rawText);
  safety.totalEntries = entries.length;
  safety.originalTokenEstimate = estimateTokens(rawText);

  // Entry count guard: truncate if exceeding maxEntries.
  if (entries.length > config.maxEntries) {
    safety.warnings.push(
      `Input truncated: ${entries.length} entries exceeds max ${config.maxEntries}. ` +
      `Processing first ${config.maxEntries} only.`,
    );
    entries = entries.slice(0, config.maxEntries);
  }

  // Build stage context (mutable, passed by reference through stages).
  const context: StageContext = {
    contentType: 'log',
    config,
    safety,
  };

  // Stage 1: Classify (assign density scores and log levels).
  const classifier = createClassifier();
  const classified = classifier.execute({ entries, context });

  // Preserve causal chains: mark entries near errors as protected.
  markCausalChains(classified.entries, config);

  // Stage 2: Filter by density threshold (with safety enforcement).
  const filtered = filterByDensity(classified.entries, context);

  // Stage 3: Deduplicate.
  const deduplicator = createDeduplicator();
  const deduped = deduplicator.execute({ entries: filtered, context });

  // Stage 4: Compress.
  const compressor = createCompressor();
  const compressed = compressor.execute({ entries: deduped.entries, context });

  // Final safety validation.
  const violations = validateProtectedEntries(entries, compressed.entries);
  context.safety.warnings.push(...violations);

  // Build output text.
  const processedText = buildOutputText(compressed.entries, context);

  return { processedText, safety: context.safety };
}

/**
 * Mark entries within ±N lines of an error as part of a causal chain.
 * These entries get reduced density so they survive filtering.
 */
function markCausalChains(entries: PreprocessEntry[], config: PreprocessorConfig): void {
  const { contextBeforeError, contextAfterError } = config.log;
  const errorIndices = new Set<number>();

  // Find all error entries.
  for (const entry of entries) {
    if (entry.level === 'error' || entry.level === 'fatal') {
      errorIndices.add(entry.index);
    }
  }

  if (errorIndices.size === 0) return;

  // Mark entries within the context window.
  for (const entry of entries) {
    if (isProtectedEntry(entry)) continue;

    for (const errIdx of errorIndices) {
      if (entry.index >= errIdx - contextBeforeError &&
          entry.index <= errIdx + contextAfterError) {
        entry.isPartOfChain = true;
        // Reduce density so it survives the threshold.
        if (entry.density !== undefined && entry.density > 0) {
          entry.density = Math.max(0, entry.density - 0.3);
        }
        break;
      }
    }
  }
}

/**
 * Filter entries by density threshold, respecting safety invariants.
 * - ERROR/FATAL entries always survive (density forced to 0).
 * - Causal chain entries get reduced density.
 * - Minimum retention ratio is enforced.
 */
function filterByDensity(
  entries: PreprocessEntry[],
  context: StageContext,
): PreprocessEntry[] {
  const threshold = context.config.log.densityThreshold;
  let kept: PreprocessEntry[] = [];
  let removed = 0;

  for (const entry of entries) {
    // Protected entries always survive.
    if (isProtectedEntry(entry) || entry.density === 0) {
      kept.push(entry);
      continue;
    }

    // Causal chain entries survive if density was reduced below threshold.
    if (entry.isPartOfChain && entry.density !== undefined && entry.density < threshold) {
      kept.push(entry);
      continue;
    }

    // Apply density threshold.
    if (entry.density !== undefined && entry.density >= threshold) {
      // WARN minimum protection: WARN entries are never fully removed
      // regardless of density threshold configuration.
      if (entry.level === 'warn') {
        kept.push(entry);
        continue;
      }

      const maxRemove = maxRemovableEntries(
        context.safety.totalEntries,
        removed,
        context.config,
      );

      if (maxRemove <= 0) {
        // Retention ratio would be violated — keep this entry.
        kept.push(entry);
        context.safety.warnings.push(
          `Retention ratio limit reached: keeping entry #${entry.index} (density=${entry.density})`,
        );
      } else {
        const key = nextBackrefKey('removed');
        context.safety.backreferenceMap[key] = entry.text;
        removed++;
      }
    } else {
      kept.push(entry);
    }
  }

  context.safety.removedByClassifier += removed;
  return kept;
}

/**
 * Build the final output text from processed entries.
 */
function buildOutputText(
  entries: PreprocessEntry[],
  context: StageContext,
): string {
  const lines: string[] = [];

  // Add safety header.
  const header = buildDenoiserHeader(context.safety);
  if (header) lines.push(header, '');

  for (const entry of entries) {
    // For deduplicated entries that represent multiple originals,
    // no special annotation needed — the dedup is transparent in output.
    lines.push(entry.text);
  }

  return lines.join('\n');
}

function buildDenoiserHeader(safety: SafetyReport): string {
  const parts: string[] = [];

  if (safety.removedByClassifier > 0) {
    parts.push(`${safety.removedByClassifier} low-signal entries filtered`);
  }
  if (safety.deduplicatedCount > 0) {
    parts.push(`${safety.deduplicatedCount} duplicates merged`);
  }
  if (safety.compressedCount > 0) {
    parts.push(`${safety.compressedCount} entries compressed`);
  }

  if (parts.length === 0) return '';

  const reduction = Math.round((1 - safety.compressionRatio) * 100);
  return `[Input preprocessed: log content — ${parts.join(', ')} — ~${reduction}% token reduction]`;
}
