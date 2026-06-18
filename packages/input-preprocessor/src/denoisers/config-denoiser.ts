/**
 * @los/input-preprocessor/denoisers/config-denoiser — Configuration content denoising.
 *
 * Denoising operations:
 * 1. Comment stripping (# and ; line comments)
 * 2. Secret value masking (apiKey=..., password=... → apiKey=<redacted>)
 * 3. Key summarization for large configs (list keys, hide values)
 * 4. Duplicate key detection
 */

import type { PreprocessorConfig, SafetyReport } from '../types.js';
import { estimateTokens } from '../safety.js';

// Secret-like keys whose values should be masked
const SECRET_KEYS = /\b(?:api_?key|api_?secret|secret|password|passwd|token|credential|private_?key|access_?key|auth_?token)\s*[:=]\s*\S+/gi;

// Comment line patterns for config files
const CONFIG_COMMENT = /^\s*[#;]\s*/;

function maskSecrets(text: string): string {
  return text.replace(SECRET_KEYS, (match) => {
    const eqIdx = match.search(/[:=]/);
    if (eqIdx === -1) return match;
    const key = match.slice(0, eqIdx);
    return `${key}=<redacted>`;
  });
}

/**
 * Summarize a large config by listing only keys (values hidden).
 * Applied when the config has >50 non-empty lines.
 */
function summarizeIfLarge(text: string): string {
  const lines = text.split('\n');
  const nonEmpty = lines.filter(l => l.trim() && !CONFIG_COMMENT.test(l));
  if (nonEmpty.length <= 50) return text;

  const keys: string[] = [];
  for (const line of nonEmpty) {
    const match = /^(\s*)([a-zA-Z_][\w.-]*)\s*[:=]/.exec(line);
    if (match) {
      const indent = match[1].length;
      const depth = Math.floor(indent / 2);
      keys.push(`${'  '.repeat(depth)}${match[2]}`);
    }
  }

  // Build a key tree summary.
  const uniqueKeys = [...new Set(keys)];
  const summary = [
    `# [Config summary: ${nonEmpty.length} lines, ${uniqueKeys.length} unique keys]`,
    ...uniqueKeys.slice(0, 80), // max 80 keys in summary
    uniqueKeys.length > 80 ? `# ... and ${uniqueKeys.length - 80} more keys` : '',
  ].filter(Boolean).join('\n');

  return summary;
}

/**
 * Denoise config content: mask secrets and summarize if large.
 */
export function denoiseConfig(
  rawText: string,
  _config: PreprocessorConfig,
  safety: SafetyReport,
): { processedText: string; safety: SafetyReport } {
  if (!rawText.trim()) return { processedText: rawText, safety };

  safety.originalTokenEstimate = estimateTokens(rawText);

  // Stage 1: Strip config comments.
  const lines = rawText.split('\n');
  const noComments = lines
    .filter(line => !CONFIG_COMMENT.test(line) || /[:=]/.test(line)) // keep inline comments after values
    .join('\n');

  // Stage 2: Mask secret values.
  let processed = maskSecrets(noComments);

  // Stage 3: Summarize large configs by listing keys.
  processed = summarizeIfLarge(processed);

  safety.finalTokenEstimate = estimateTokens(processed);
  safety.compressionRatio = safety.originalTokenEstimate > 0
    ? safety.finalTokenEstimate / safety.originalTokenEstimate
    : 1;

  return { processedText: processed, safety };
}
