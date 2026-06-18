/**
 * @los/input-preprocessor/detectors/log-detector — Log content type detector.
 *
 * Heuristics (evaluated in order, short-circuit on high-confidence match):
 * 1. Timestamp prefix: [HH:MM:SS] or [HH:MM:SS.mmm] in first 10 lines
 * 2. Log level keywords: DEBUG/INFO/WARN/ERROR/FATAL/TRACE density
 * 3. JSON log line density: JSON lines with level/timestamp/message keys
 * 4. Newline density boost: many short lines → more likely log
 * 5. Fallback: unknown with low confidence
 */

import type { ContentDetector, ContentTypeDetection } from './detector.js';

// Matches [HH:MM:SS] or [HH:MM:SS.mmm] at line start, common in dev/terminal logs.
const TIMESTAMP_REGEX = /^\[?\d{2}:\d{2}:\d{2}(?:\.\d{3})?\]?/;

// Log level keywords (case-insensitive matching).
const LOG_LEVELS = /\b(DEBUG|INFO|WARN(?:ING)?|ERROR|FATAL|TRACE)\b/i;

// JSON log detection: these keys strongly indicate structured log entries.
const JSON_LOG_KEYS = ['level', 'timestamp', 'message', 'logger', 'msg'];

// Minimum lines to attempt log detection.
const MIN_LINES_FOR_DETECTION = 3;

/**
 * Create a log content detector.
 * Pure function — no external state or configuration.
 */
export function createLogDetector(): ContentDetector {
  return {
    name: 'log-detector',
    detect(input: string): ContentTypeDetection | null {
      // Use limit to avoid creating a full array for very large inputs.
      // We only ever sample the first 50 lines.
      const lines = input.split(/\r?\n/, 51);
      if (lines.length < MIN_LINES_FOR_DETECTION) return null;

      // Sample: first 10 lines for timestamp check, first 50 for level check.
      const first10 = lines.slice(0, Math.min(10, lines.length));
      const first50 = lines.slice(0, Math.min(50, lines.length));

      // Heuristic 1: Timestamp prefix density.
      const tsMatches = first10.filter(l => TIMESTAMP_REGEX.test(l.trim())).length;
      const tsRatio = tsMatches / first10.length;
      if (tsRatio >= 0.6) {
        return {
          type: 'log',
          confidence: 0.95,
          evidence: [`timestamp prefix detected in ${Math.round(tsRatio * 100)}% of first ${first10.length} lines`],
        };
      }

      // Heuristic 2: Log level keyword density.
      const levelMatches = first50.filter(l => LOG_LEVELS.test(l)).length;
      const levelRatio = levelMatches / first50.length;
      if (levelRatio >= 0.15) {
        const confidence = 0.85 + (levelRatio - 0.15) * 0.1; // 0.85-0.95 range
        return {
          type: 'log',
          confidence: Math.min(confidence, 0.95),
          evidence: [`log level keywords in ${Math.round(levelRatio * 100)}% of first ${first50.length} lines`],
        };
      }

      // Heuristic 3: JSON log line density.
      let jsonHits = 0;
      for (const line of first50) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('{')) continue;
        try {
          const obj = JSON.parse(trimmed) as Record<string, unknown>;
          const hasLogKeys = JSON_LOG_KEYS.some(k => k in obj);
          if (hasLogKeys) jsonHits++;
        } catch { /* not JSON */ }
      }
      const jsonRatio = jsonHits / first50.length;
      if (jsonRatio >= 0.3) {
        return {
          type: 'log',
          confidence: 0.90,
          evidence: [`JSON log format detected in ${Math.round(jsonRatio * 100)}% of first ${first50.length} lines`],
        };
      }

      // Heuristic 4: Newline density — many short lines suggest log output.
      const avgLineLen = input.length / lines.length;
      if (lines.length > 20 && avgLineLen < 300 && levelRatio >= 0.05) {
        return {
          type: 'log',
          confidence: 0.55 + levelRatio * 0.5, // 0.55-0.65 range
          evidence: [
            `high line count (${lines.length}) with low avg line length (${Math.round(avgLineLen)} chars)`,
            `sparse log keywords (${Math.round(levelRatio * 100)}%)`,
          ],
        };
      }

      // Heuristic 5: Sparse log keywords with moderate line count.
      if (levelRatio >= 0.05 && lines.length >= 10) {
        return {
          type: 'log',
          confidence: 0.40,
          evidence: [`sparse log keywords (${Math.round(levelRatio * 100)}%) in ${lines.length} lines`],
        };
      }

      return null;
    },
  };
}
