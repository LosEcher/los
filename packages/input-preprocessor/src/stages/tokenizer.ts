/**
 * @los/input-preprocessor/stages/tokenizer — Logical entry splitter.
 *
 * Splits raw text into PreprocessEntry[] respecting multi-line structures:
 * - Stack trace frames (indented lines starting with "at ", "Caused by:", etc.)
 * - JSON continuations (lines within a JSON object)
 * - Blank-line separated paragraphs for non-log content
 */

import type { PreprocessEntry, StageInput, StageOutput } from '../types.js';
import type { PreprocessStage } from './stage.js';

// Patterns that indicate a continuation line (should be grouped with previous entry).
const CONTINUATION_PATTERNS = [
  /^\s+at\s/,                    // stack frame: "    at com.example...", "  at <anonymous>"
  /^\s+\.{3}\s+\d+\s+(more|frame)/, // truncated stack: "    ... 42 more"
  /^Caused by:\s/,               // exception chain
  /^\s+\.\.\./,                  // ellipsis continuation
  /^\s+\^/,                      // error pointer: "      ^^^^^^"
  /^\s+\{/,                      // JSON continuation
  /^\s+\[/,                      // array continuation in JSON
  /^\s+"[^"]+"\s*:/,            // JSON key-value continuation
];

function isContinuationLine(line: string): boolean {
  const trimmed = line;
  if (!trimmed) return false;
  for (const pattern of CONTINUATION_PATTERNS) {
    if (pattern.test(trimmed)) return true;
  }
  // Generic indentation check: if line starts with 2+ spaces and previous was non-empty
  if (/^\s{2,}\S/.test(trimmed)) return true;
  return false;
}

/**
 * Create a tokenizer stage.
 * For log content: splits on newlines, groups continuations.
 * For non-log content: splits on blank-line separated paragraphs.
 */
export function createTokenizer(): PreprocessStage {
  return {
    name: 'tokenizer',
    execute(input: StageInput): StageOutput {
      const { entries: _, context } = input;
      const rawText = '';  // rawText isn't on StageInput directly — we get it from context
      // Actually, the raw text should be passed through. Let's get it via context metadata.
      // For now, we handle this in the denoiser which has access to rawText.

      // The denoiser passes entries as a single entry with the full text in index 0.
      // We handle both cases: pre-split (from denoiser) and raw (first entry = full text).

      return { entries: [], context };  // Placeholder — real impl below
    },
  };
}

/**
 * Split raw log text into logical entries, grouping continuation lines.
 * Pure function, exported for direct use by denoisers and testing.
 */
export function tokenizeLog(rawText: string): PreprocessEntry[] {
  const lines = rawText.split(/\r?\n/);
  const entries: PreprocessEntry[] = [];
  let currentLines: string[] = [];
  let currentIndex = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const isContinuation = currentLines.length > 0 && isContinuationLine(line);

    if (isContinuation) {
      currentLines.push(line);
    } else {
      // Flush previous entry
      if (currentLines.length > 0) {
        entries.push({
          index: currentIndex,
          text: currentLines.join('\n'),
        });
        currentIndex++;
      }
      // Start new entry (skip truly empty lines)
      if (line.trim()) {
        currentLines = [line];
      } else {
        currentLines = [];
      }
    }
  }

  // Flush final entry
  if (currentLines.length > 0) {
    entries.push({
      index: currentIndex,
      text: currentLines.join('\n'),
    });
  }

  return entries;
}

/**
 * Split generic (non-log) text into entries by blank-line paragraphs.
 */
export function tokenizeGeneric(rawText: string): PreprocessEntry[] {
  const paragraphs = rawText.split(/\n\s*\n/);
  return paragraphs
    .map((text, i) => ({ index: i, text: text.trim() }))
    .filter(e => e.text.length > 0);
}
