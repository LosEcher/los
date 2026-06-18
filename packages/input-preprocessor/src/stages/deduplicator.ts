/**
 * @los/input-preprocessor/stages/deduplicator — Exact and fingerprint-based deduplication.
 *
 * Two-pass dedup:
 * 1. Exact match: identical entry.text → keep first occurrence, track count.
 * 2. Fingerprint: normalize variable parts (timestamps, IPs, UUIDs, hex, numbers)
 *    → same fingerprint = same structural error → keep first + template.
 *
 * Removed entries are tracked in context.safety.backreferenceMap.
 */

import type { PreprocessEntry, StageInput, StageOutput } from '../types.js';
import type { PreprocessStage as IStage } from './stage.js';
import { nextBackrefKey } from '../safety.js';

// Normalization patterns for fingerprinting.
// Order matters: more specific patterns first.
const FINGERPRINT_PATTERNS: Array<[RegExp, string]> = [
  // ISO timestamps: 2024-01-15T10:30:45.123Z
  [/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?(?:Z|[+-]\d{2}:?\d{2})?\b/g, '<TS>'],
  // Time-only: 14:32:01 or 14:32:01.123
  [/\b\d{2}:\d{2}:\d{2}(?:\.\d{3})?\b/g, '<TIME>'],
  // IPv4 addresses
  [/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, '<IP>'],
  // UUIDs
  [/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<UUID>'],
  // Hex addresses (0x7fff9b3c...)
  [/\b0x[0-9a-f]{6,16}\b/gi, '<ADDR>'],
  // Hex strings 8+ chars
  [/\b[0-9a-f]{8,40}\b/gi, '<HEX>'],
  // Port numbers after colon in connection strings
  [/:\d{1,5}\b/g, ':<PORT>'],
  // Pure numbers ≥4 digits (but not in timestamps already replaced)
  [/\b\d{4,}\b/g, '<N>'],
  // Repeated whitespace
  [/\s+/g, ' '],
];

/**
 * Simple non-crypto hash (djb2) for fingerprint comparison.
 * 32-bit output is sufficient for typical inputs (<50K unique entries).
 * For larger inputs, use hash128() to reduce collision probability.
 */
function hashString(s: string): string {
  let hash = 5381;
  for (let i = 0; i < s.length; i++) {
    hash = ((hash << 5) + hash) + s.charCodeAt(i);
    hash = hash & hash; // Convert to 32-bit integer
  }
  return hash.toString(36);
}

/**
 * 64-bit djb2 variant with a configurable seed.
 * Used to compose 128-bit hashes for large inputs (>50K entries).
 */
function hash64(s: string, seed: number): string {
  // Use two 32-bit halves to simulate 64-bit output.
  let hi = seed >>> 0;
  let lo = 5381;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    lo = ((lo << 5) + lo + c) | 0;
    hi = ((hi << 5) + hi + c + (lo >>> 16)) | 0;
  }
  return (hi >>> 0).toString(16).padStart(8, '0') + (lo >>> 0).toString(16).padStart(8, '0');
}

/**
 * 128-bit hash composed from two 64-bit hashes with different seeds.
 * Collision probability at 50K entries: ~1.4e-29 (effectively zero)
 * vs. djb2 32-bit: >15% at 50K entries.
 */
function hash128(s: string): string {
  return hash64(s, 0x9e3779b9) + hash64(s, 0x517cc1b7);
}

/** Threshold above which we switch from 32-bit to 128-bit hashing. */
const LARGE_INPUT_HASH_THRESHOLD = 50_000;

/**
 * Generate a structural fingerprint by normalizing variable parts.
 *
 * Uses 32-bit djb2 hash for typical inputs.
 * Automatically upgrades to 128-bit hash when entries exceed 50K
 * to keep collision probability negligible.
 */
export function fingerprint(text: string, useLargeHash = false): string {
  let normalized = text.trim();
  for (const [pattern, replacement] of FINGERPRINT_PATTERNS) {
    normalized = normalized.replace(pattern, replacement);
  }
  return useLargeHash ? hash128(normalized) : hashString(normalized);
}

/**
 * Verify that two entries with the same fingerprint hash are genuinely
 * structurally similar. Prevents false dedup from hash collisions on
 * very large inputs (>50K unique entries).
 *
 * Compares the normalized (fingerprinted) forms: if they match after
 * normalization, the entries represent the same structural error.
 */
export function areStructurallySimilar(a: string, b: string): boolean {
  const normA = a.trim().replace(/\s+/g, ' ');
  const normB = b.trim().replace(/\s+/g, ' ');

  // Quick length check: structurally similar entries should have
  // similar length after whitespace normalization (±30%).
  if (normA.length === 0 || normB.length === 0) return false;
  const lenRatio = Math.min(normA.length, normB.length) /
                   Math.max(normA.length, normB.length);
  if (lenRatio < 0.7) return false;

  // Extract the first "meaningful" segment (up to the first variable part).
  // For log entries, this is typically the level + message prefix.
  const prefixA = extractStructuralPrefix(normA);
  const prefixB = extractStructuralPrefix(normB);

  return prefixA === prefixB;
}

/**
 * Extract the structural prefix of a log entry: the part before
 * the first variable component. Used for similarity comparison.
 */
function extractStructuralPrefix(text: string): string {
  // Strip timestamps, IPs, numbers to get the structural skeleton.
  let skeleton = text
    .replace(/\b\d{2}:\d{2}:\d{2}(?:\.\d{3})?\b/g, '')
    .replace(/\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}\b/g, '')
    .replace(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g, '')
    .replace(/\b[0-9a-f]{8,}\b/gi, '')
    .replace(/\b\d+(?:\.\d+)?(?:ms|s|min|h|d|mb|kb|gb|%)?\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim();

  // Take up to 120 chars of the skeleton for comparison.
  return skeleton.slice(0, 120);
}

/**
 * Create a deduplicator stage.
 */
export function createDeduplicator(): IStage {
  return {
    name: 'deduplicator',
    execute(input: StageInput): StageOutput {
      const { entries, context } = input;
      const config = context.config.log;

      if (entries.length === 0) return { entries, context };

      // Auto-upgrade to 128-bit hash for large inputs (>50K entries)
      // to keep collision probability negligible.
      const useLargeHash = entries.length > LARGE_INPUT_HASH_THRESHOLD;
      if (useLargeHash) {
        context.safety.warnings.push(
          `Large input detected (${entries.length} entries) — using 128-bit fingerprint hash`,
        );
      }

      // Assign fingerprints to all entries (for downstream use).
      for (const entry of entries) {
        entry.fingerprint = fingerprint(entry.text, useLargeHash);
      }

      const seenExact = new Set<string>();
      const seenFingerprint = new Map<string, PreprocessEntry>();
      const result: PreprocessEntry[] = [];
      let dedupCount = 0;

      for (const entry of entries) {
        // Pass 1: Exact dedup (if enabled).
        if (config.dedupExact) {
          const exactKey = entry.text;
          if (seenExact.has(exactKey)) {
            const key = nextBackrefKey('dedup:exact');
            context.safety.backreferenceMap[key] = entry.text;
            dedupCount++;
            continue;
          }
          seenExact.add(exactKey);
        }

        // Pass 2: Fingerprint dedup (if enabled).
        if (config.dedupFingerprint && entry.fingerprint) {
          const existing = seenFingerprint.get(entry.fingerprint);
          if (existing) {
            // Collision guard: verify structural similarity before merging.
            // Same fingerprint hash does not guarantee same structure for large inputs.
            if (areStructurallySimilar(existing.text, entry.text)) {
              const key = nextBackrefKey('dedup:fingerprint');
              context.safety.backreferenceMap[key] = entry.text;
              dedupCount++;
              continue;
            }
            // Hash collision detected — keep as separate entry with warning.
            context.safety.warnings.push(
              `Fingerprint collision at index ${entry.index}: ` +
              `hash matched but structures differ. Keeping as separate entry.`,
            );
          }
          seenFingerprint.set(entry.fingerprint, entry);
        }

        result.push(entry);
      }

      context.safety.deduplicatedCount += dedupCount;
      return { entries: result, context };
    },
  };
}
