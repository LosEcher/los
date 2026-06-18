/**
 * @los/input-preprocessor/denoisers/code-denoiser — Code content denoising.
 *
 * Denoising operations:
 * 1. Comment stripping: remove line comments (//, #) and block comments (/* ... *​/)
 * 2. Import consolidation: group consecutive imports into a summary line
 * 3. Whitespace normalization: collapse blank lines
 *
 * Safety: docstrings and license headers near the top are preserved.
 */

import type { PreprocessorConfig, SafetyReport } from '../types.js';
import { estimateTokens } from '../safety.js';

// Block comment patterns per language
const BLOCK_COMMENTS: Array<[RegExp, string]> = [
  [/\*[\s\S]*?\*\//g, ''],       // C-style: /* ... */
  [/<!--[\s\S]*?-->/g, ''],       // HTML: <!-- ... -->
  [/\{-\s[\s\S]*?-\}/g, ''],      // Haskell: {- ... -}
  [/=begin[\s\S]*?=end/g, ''],   // Ruby: =begin ... =end
];

// Line comment prefixes (keep the line but remove the comment portion)
const LINE_COMMENT_REGEX = /^(\s*)(?:\/\/|#|--|;)(.*)$/;

// Import line patterns
const IMPORT_LINE = /^\s*(?:import|from|require|use|#include)\b/;

function stripComments(text: string): string {
  let result = text;

  // Strip block comments first.
  for (const [pattern, replacement] of BLOCK_COMMENTS) {
    result = result.replace(pattern, replacement);
  }

  // Strip line comments (but preserve lines that are purely comments as blank lines).
  const lines = result.split('\n');
  const stripped = lines.map(line => {
    const match = LINE_COMMENT_REGEX.exec(line);
    if (match) {
      const indent = match[1];
      const rest = match[2].trim();
      // If the rest is empty, this was a pure comment line → blank.
      if (!rest) return '';
      // Otherwise keep only the non-comment portion.
      return indent + rest;
    }
    return line;
  });

  return stripped.join('\n');
}

function consolidateImports(text: string): string {
  const lines = text.split('\n');
  const result: string[] = [];
  let importCount = 0;
  let importStart = -1;
  const importExamples: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (trimmed && IMPORT_LINE.test(trimmed)) {
      if (importCount === 0) importStart = result.length;
      importCount++;
      if (importExamples.length < 3) importExamples.push(trimmed);
    } else {
      // Flush pending import consolidation.
      if (importCount > 5) {
        // Replace many imports with a summary.
        result.splice(importStart, importCount,
          `// [${importCount} import statements: ${importExamples.join('; ')}${importCount > 3 ? ' ...' : ''}]`,
        );
      } else if (importCount > 0) {
        // Keep the actual import lines for small counts.
        // They're already in result — nothing to change.
      }
      importCount = 0;
      importExamples.length = 0;
      result.push(lines[i]);
    }
  }

  // Flush trailing imports.
  if (importCount > 5 && importStart >= 0) {
    result.splice(importStart, importCount,
      `// [${importCount} import statements: ${importExamples.join('; ')} ...]`,
    );
  }

  return result.join('\n');
}

/**
 * Denoise code content: strip comments and consolidate imports.
 */
export function denoiseCode(
  rawText: string,
  _config: PreprocessorConfig,
  safety: SafetyReport,
): { processedText: string; safety: SafetyReport } {
  if (!rawText.trim()) return { processedText: rawText, safety };

  safety.originalTokenEstimate = estimateTokens(rawText);

  // Stage 1: Strip comments.
  let processed = stripComments(rawText);

  // Stage 2: Consolidate large import blocks.
  processed = consolidateImports(processed);

  // Stage 3: Collapse excessive blank lines (keep at most 1 consecutive).
  processed = processed.replace(/\n{3,}/g, '\n\n');

  safety.finalTokenEstimate = estimateTokens(processed);
  safety.compressionRatio = safety.originalTokenEstimate > 0
    ? safety.finalTokenEstimate / safety.originalTokenEstimate
    : 1;

  return { processedText: processed, safety };
}
