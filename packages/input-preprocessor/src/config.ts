/**
 * @los/input-preprocessor/config — Zod-driven configuration schema.
 *
 * Follows the @los/infra/config pattern: single Zod schema → TypeScript types auto-derived.
 */

import { z } from '@los/infra/config';
import type { PreprocessorConfig } from './types.js';

export const PreprocessorConfigSchema = z.object({
  enabled: z.boolean().default(true),
  tokenBudget: z.number().int().nonnegative().default(0),
  maxInputBytes: z.number().int().positive().default(10_485_760), // 10 MB
  maxEntries: z.number().int().positive().default(100_000),
  minRetentionRatio: z.number().min(0).max(1).default(0.3),
  minConfidence: z.number().min(0).max(1).default(0.5),
  log: z.object({
    noiseLevels: z.array(z.string()).default(['debug', 'trace']),
    maxEntryLength: z.number().int().positive().default(2000),
    densityThreshold: z.number().min(0).max(1).default(0.6),
    elideFields: z.array(z.string()).default([
      'service_id',
      'instance_id',
      'spanId',
      'traceId',
      'thread',
      'threadId',
      'process_id',
      'hostname',
      'logger',
      'file',
      'line',
    ]),
    dedupFingerprint: z.boolean().default(true),
    dedupExact: z.boolean().default(true),
    contextBeforeError: z.number().int().nonnegative().max(100).default(5),
    contextAfterError: z.number().int().nonnegative().max(100).default(3),
  }).default({}),
});

/** Resolve config by merging overrides into defaults. */
export function resolveConfig(
  overrides?: z.input<typeof PreprocessorConfigSchema>,
): PreprocessorConfig {
  return PreprocessorConfigSchema.parse(overrides ?? {}) as PreprocessorConfig;
}

/** Default config with all built-in values. */
export function defaultConfig(): PreprocessorConfig {
  return PreprocessorConfigSchema.parse({}) as PreprocessorConfig;
}
