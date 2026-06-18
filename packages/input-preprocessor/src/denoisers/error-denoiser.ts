/**
 * @los/input-preprocessor/denoisers/error-denoiser — Error/stack trace denoising pipeline.
 *
 * Assembles the error processing chain:
 *   Tokenizer → Classifier → Deduplicator → Compressor
 *
 * Error-specific denoising:
 * - Preserve the error header/message (never removed).
 * - Fold repeated stack frames from library code (node_modules, site-packages, vendor).
 * - Keep application-code frames intact.
 * - Collapse "Caused by" chains to show the chain without full frame repetition.
 * - Deduplicate structurally identical stack traces.
 */

import type {
  PreprocessEntry,
  PreprocessorConfig,
  SafetyReport,
  StageContext,
} from '../types.js';
import { createDeduplicator } from '../stages/deduplicator.js';
import {
  isProtectedEntry,
  validateProtectedEntries,
  maxRemovableEntries,
  resetBackrefCounter,
  estimateTokens,
} from '../safety.js';

// Library/vendor paths that indicate "collapseable" frames.
// These are less useful to the LLM than application frames.
const LIBRARY_PATTERNS = [
  /node_modules\//,
  /\/site-packages\//,
  /\/dist-packages\//,
  /\/vendor\//,
  /\/.venv\//,
  /\/node_modules\/.pnpm\//,
  /\/\.cargo\/registry\//,
  /\/\.nuget\/packages\//,
  /\/maven\/repository\//,
  /\/\.m2\/repository\//,
  /internal\/modules\//, // Node.js internal
  /\(node:internal/,    // Node.js internals
];

function isLibraryFrame(text: string): boolean {
  return LIBRARY_PATTERNS.some(p => p.test(text));
}

/**
 * Tokenize error content into logical entries.
 * Splits stack traces into individual frame entries for classification.
 */
function tokenizeError(rawText: string): PreprocessEntry[] {
  const lines = rawText.split('\n');
  const entries: PreprocessEntry[] = [];

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    // Error header: multi-line error message before the first stack frame.
    // Keep the header as a single entry.
    if (trimmed && !trimmed.startsWith('at ') && !trimmed.startsWith('File ') && i < 20) {
      // Non-frame line near the top — likely error message.
      let headerText = trimmed;
      i++;
      // Absorb continuation lines (indented or without "at" prefix) until we hit a stack frame.
      while (i < lines.length) {
        const next = lines[i].trim();
        if (!next || next.startsWith('at ') || next.startsWith('File ') ||
            /^goroutine\s+\d+/.test(next) || /^Caused by:/.test(next)) {
          break;
        }
        headerText += '\n' + next;
        i++;
      }
      entries.push({ index: entries.length, text: headerText });
      continue;
    }

    // Stack frame: single-line entry.
    if (trimmed) {
      entries.push({ index: entries.length, text: trimmed });
    }
    i++;
  }

  return entries;
}

/**
 * Error-specific classification: assign density based on frame type.
 * Library frames → high density (candidate for folding).
 * Application frames / error messages → low density (preserve).
 */
function classifyErrors(entries: PreprocessEntry[]): void {
  for (const entry of entries) {
    // Error headers are always important.
    if (!entry.text.startsWith('at ') && !entry.text.startsWith('File ')) {
      entry.level = 'error'; // treated as protected
      entry.density = 0;
      continue;
    }

    // Library frames are high-density (can be folded).
    if (isLibraryFrame(entry.text)) {
      entry.density = 0.8;
      entry.level = 'debug';
    } else {
      // Application frames: preserve but with lower priority than headers.
      entry.density = 0.2;
      entry.level = 'info';
    }
  }
}

/**
 * Error-specific compression: fold repeated library frames.
 *
 * When consecutive library frames appear, keep only the first and last
 * with a count annotation. Application frames are untouched.
 */
function compressErrors(entries: PreprocessEntry[]): PreprocessEntry[] {
  const result: PreprocessEntry[] = [];
  let i = 0;

  while (i < entries.length) {
    const entry = entries[i];

    // Check for consecutive library frames.
    if (isLibraryFrame(entry.text) && i + 1 < entries.length && isLibraryFrame(entries[i + 1].text)) {
      let libCount = 0;
      const firstLib = entry;
      let lastLib = entry;
      let j = i;

      while (j < entries.length && isLibraryFrame(entries[j].text)) {
        libCount++;
        lastLib = entries[j];
        j++;
      }

      if (libCount <= 3) {
        // Few library frames — keep them all.
        for (let k = i; k < j; k++) {
          result.push(entries[k]);
        }
      } else {
        // Fold: keep first, annotation, last.
        result.push({ ...firstLib, index: result.length });
        result.push({
          index: result.length,
          text: `  [... ${libCount - 2} intermediate library frames omitted ...]`,
          level: 'debug',
          density: 0.9,
          metadata: { folded: libCount - 2 },
        });
        result.push({ ...lastLib, index: result.length });
      }

      i = j;
      continue;
    }

    result.push(entry);
    i++;
  }

  return result;
}

/**
 * Denoise error/stack trace content.
 *
 * Pipeline:
 * 1. Tokenize into header + frame entries.
 * 2. Classify by frame type (library vs application).
 * 3. Deduplicate structurally identical frames (same file:line).
 * 4. Compress by folding consecutive library frames.
 * 5. Validate safety invariants.
 */
export function denoiseError(
  rawText: string,
  config: PreprocessorConfig,
  safety: SafetyReport,
): { processedText: string; safety: SafetyReport } {
  resetBackrefCounter();

  // Stage 1: Tokenize.
  const entries = tokenizeError(rawText);
  safety.totalEntries = entries.length;

  if (entries.length === 0) {
    return { processedText: rawText, safety };
  }

  // Stage 2: Classify by frame type.
  classifyErrors(entries);

  // Stage 3: Deduplicate structurally identical entries.
  // Use the generic deduplicator but with fingerprint patterns suited for stack traces.
  const context: StageContext = { contentType: 'error', config, safety };
  const deduplicator = createDeduplicator();
  const dedupResult = deduplicator.execute({ entries: [...entries], context });

  // Stage 4: Compress library frames.
  const compressed = compressErrors(dedupResult.entries);

  // Stage 5: Filter by density (keep low-density = application + headers).
  const surviving = compressed.filter(e => {
    if (isProtectedEntry(e)) return true;
    // Error headers and non-library frames survive.
    if (e.level === 'error' || e.level === 'warn' || (e.density ?? 0) <= 0.3) return true;
    return false;
  });

  // Safety: validate no error headers were lost.
  const violations = validateProtectedEntries(compressed, surviving);
  if (violations.length > 0) {
    safety.warnings.push(...violations);
    return { processedText: rawText, safety }; // passthrough on violation
  }

  // Enforce minimum retention ratio using log config density threshold as guide.
  const maxRemove = maxRemovableEntries(entries.length, entries.length - surviving.length, config);
  const finalEntries = maxRemove >= 0 ? surviving : compressed.slice(0, entries.length);

  safety.compressedCount += compressed.length - finalEntries.length;

  // Reassemble text.
  const processedText = finalEntries.map(e => e.text).join('\n');
  safety.finalTokenEstimate = estimateTokens(processedText);
  safety.compressionRatio = safety.originalTokenEstimate > 0
    ? safety.finalTokenEstimate / safety.originalTokenEstimate
    : 1;

  return { processedText, safety };
}
