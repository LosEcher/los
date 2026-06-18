/**
 * @los/input-preprocessor/stages/classifier — Entry density/importance scoring.
 *
 * Scores each entry 0..1 where higher = more likely noise.
 * Preserves ERROR/FATAL entries unconditionally (density = 0).
 *
 * Scoring factors for logs:
 * - ERROR/FATAL level: density forced to 0 (never remove)
 * - WARN level: density capped at 0.3
 * - DEBUG/TRACE level: base density 0.4+
 * - INFO level: base density 0.15
 * - Heartbeat/health-check patterns: +0.3
 * - High token-to-content ratio: +0.2
 */

import type { LogLevel, PreprocessEntry, StageInput, StageOutput } from '../types.js';
import type { PreprocessStage as IStage } from './stage.js';

// Patterns that indicate low-signal heartbeat/health-check entries.
const HEARTBEAT_PATTERNS = [
  /\bheartbeat\b/i,
  /\bhealth.check\b/i,
  /\bping\b/i,
  /\bkeep[-_]?alive\b/i,
  /\bliveness\b/i,
  /\bready\b.*\bcheck\b/i,
  /GET\s+\/health\b/i,
  /GET\s+\/ping\b/i,
  /GET\s+\/ready\b/i,
  /GET\s+\/live\b/i,
  /\bstatus.*200\b.*\bOK\b/i,
];

// Patterns for successful operations that are typically low-signal in bulk.
const LOW_SIGNAL_PATTERNS = [
  /\bsuccessfully\s+(processed|completed|handled|saved|created|updated|deleted)/i,
  /\boperation\s+completed\s+successfully\b/i,
  /status.*200\b(?!.*error)/i,
];

const LEVEL_PRIORITY: Record<string, number> = {
  debug: 0,
  trace: 0,
  info: 1,
  warn: 2,
  error: 3,
  fatal: 4,
};

/**
 * Extract log level from entry text.
 * Checks common log formats: [LEVEL], "level", LEVEL prefix, JSON "level" field.
 */
export function extractLogLevel(text: string): LogLevel {
  const trimmed = text.trim();

  // Bracketed format: [DEBUG], [INFO], etc.
  const bracketMatch = trimmed.match(/^\[(DEBUG|INFO|WARN(?:ING)?|ERROR|FATAL|TRACE)\]/i);
  if (bracketMatch) return normalizeLevel(bracketMatch[1]!);

  // Space-separated: "DEBUG ...", "INFO ..."
  const spaceMatch = trimmed.match(/^(DEBUG|INFO|WARN(?:ING)?|ERROR|FATAL|TRACE)\s/i);
  if (spaceMatch) return normalizeLevel(spaceMatch[1]!);

  // JSON log: {"level": "error", ...}
  // Quick pre-check before attempting JSON.parse to avoid wasted cycles
  // on non-JSON strings that happen to start with '{'.
  if (trimmed.startsWith('{') && /"(level|severity|message|timestamp)"/.test(trimmed.slice(0, 200))) {
    try {
      const obj = JSON.parse(trimmed) as Record<string, unknown>;
      if (typeof obj.level === 'string') return normalizeLevel(obj.level);
      if (typeof obj.severity === 'string') return normalizeLevel(obj.severity);
    } catch { /* not JSON */ }
  }

  // Bracketed timestamp + level: "[14:32:01] ERROR ...", "[2024-01-15] WARN ..."
  const bracketTsMatch = trimmed.match(/^\[[^\]]*\]\s+(DEBUG|INFO|WARN(?:ING)?|ERROR|FATAL|TRACE)\b/i);
  if (bracketTsMatch) return normalizeLevel(bracketTsMatch[1]!);

  // Timestamp + level format: "2024-01-15 10:30:45 ERROR ..."
  const tsMatch = trimmed.match(/^\S+\s+\S+\s+(DEBUG|INFO|WARN(?:ING)?|ERROR|FATAL|TRACE)\b/i);
  if (tsMatch) return normalizeLevel(tsMatch[1]!);

  return 'unknown';
}

function normalizeLevel(raw: string): LogLevel {
  const l = raw.toLowerCase();
  if (l === 'warning') return 'warn';
  if (l === 'debug' || l === 'info' || l === 'warn' || l === 'error' || l === 'fatal' || l === 'trace') return l;
  return 'unknown';
}

/**
 * Check if entry text matches any of the given patterns.
 */
function matchesAny(text: string, patterns: RegExp[]): boolean {
  return patterns.some(p => p.test(text));
}

/**
 * Create a classifier stage for log content.
 */
export function createClassifier(): IStage {
  return {
    name: 'classifier',
    execute(input: StageInput): StageOutput {
      const { entries, context } = input;
      const config = context.config.log;

      for (const entry of entries) {
        const level = extractLogLevel(entry.text);
        entry.level = level;

        // ERROR/FATAL are protected — density forced to 0.
        if (level === 'error' || level === 'fatal') {
          entry.density = 0;
          continue;
        }

        // Compute base density from log level.
        let density = computeBaseDensity(level);

        // Noise level boost: if this level is in the configured noise list.
        if (config.noiseLevels.includes(level)) {
          density += 0.15;
        }

        // Heartbeat/health-check detection.
        if (matchesAny(entry.text, HEARTBEAT_PATTERNS)) {
          density += 0.3;
        }

        // Low-signal successful operation.
        if (matchesAny(entry.text, LOW_SIGNAL_PATTERNS)) {
          density += 0.15;
        }

        // High token-to-content ratio (long entries that survived the error skip above).
        if (entry.text.length > 500) {
          density += 0.1;
        }

        // WARN cap: warnings are potentially useful, don't remove aggressively.
        if (level === 'warn') {
          density = Math.min(density, 0.3);
        }

        // Clamp to [0, 1].
        entry.density = Math.max(0, Math.min(1, Math.round(density * 100) / 100));
      }

      return { entries, context };
    },
  };
}

function computeBaseDensity(level: LogLevel): number {
  switch (level) {
    case 'debug':
    case 'trace': return 0.4;
    case 'info':  return 0.15;
    case 'warn':  return 0.1;
    case 'error':
    case 'fatal': return 0;   // Never remove
    default:      return 0.25; // unknown level — moderate density
  }
}
