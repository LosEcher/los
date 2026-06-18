/**
 * @los/input-preprocessor/detectors/mixed-detector — Mixed content type detector.
 *
 * Strategy: runs all registered detectors and detects when the input
 * contains multiple distinct content types (e.g., logs interleaved with
 * code snippets or error stacks). Returns the primary type with
 * secondary types and segments when different sections match different
 * detectors.
 *
 * Detection approach:
 * 1. Split input into blank-line-separated segments.
 * 2. Run each detector on each segment.
 * 3. If different segments match different types → mixed.
 * 4. Return primary type (highest segment count) + secondary types.
 */

import type { ContentDetector } from './detector.js';
import type { ContentTypeDetection } from '../types.js';
import { createLogDetector } from './log-detector.js';
import { createErrorDetector } from './error-detector.js';
import { createCodeDetector } from './code-detector.js';
import { createConfigDetector } from './config-detector.js';

const MIN_LINES = 5;
const MIN_SEGMENT_LINES = 3;

export function createMixedDetector(): ContentDetector {
  return {
    name: 'mixed-detector',
    detect(input: string): ContentTypeDetection | null {
      const lines = input.split(/\r?\n/);
      if (lines.length < MIN_LINES) return null;

      // Split into blank-line-separated segments.
      const segments: Array<{ lines: string[]; text: string }> = [];
      let current: string[] = [];
      for (const line of lines) {
        if (line.trim() === '' && current.length > 0) {
          segments.push({ lines: current, text: current.join('\n') });
          current = [];
        } else if (line.trim() !== '') {
          current.push(line);
        }
      }
      if (current.length > 0) {
        segments.push({ lines: current, text: current.join('\n') });
      }

      // Need at least 2 meaningful segments for mixed detection.
      const meaningfulSegments = segments.filter(s => s.lines.length >= MIN_SEGMENT_LINES);
      if (meaningfulSegments.length < 2) return null;

      // Run all detectors on each segment.
      const detectors: ContentDetector[] = [
        createLogDetector(),
        createErrorDetector(),
        createCodeDetector(),
        createConfigDetector(),
      ];

      const segmentResults = meaningfulSegments.map(seg => {
        const detections: Array<{ type: string; confidence: number }> = [];
        for (const d of detectors) {
          const result = d.detect(seg.text);
          if (result && result.confidence >= 0.40) {
            detections.push({ type: result.type, confidence: result.confidence });
          }
        }
        return { segment: seg, detections };
      });

      // Count type occurrences across segments.
      const typeCounts = new Map<string, number>();
      const typeConfidences = new Map<string, number[]>();
      for (const { detections } of segmentResults) {
        for (const d of detections) {
          typeCounts.set(d.type, (typeCounts.get(d.type) ?? 0) + 1);
          const confs = typeConfidences.get(d.type) ?? [];
          confs.push(d.confidence);
          typeConfidences.set(d.type, confs);
        }
      }

      // Need at least 2 distinct types detected.
      const distinctTypes = [...typeCounts.entries()].filter(([, count]) => count > 0);
      if (distinctTypes.length < 2) return null;

      // Primary type = most segments matched.
      distinctTypes.sort((a, b) => b[1] - a[1]);
      const primary = distinctTypes[0];
      const secondary = distinctTypes.slice(1);

      // Confidence: higher when secondary types are strong.
      const secondaryMinConf = Math.min(
        ...secondary.map(([type]) => {
          const confs = typeConfidences.get(type) ?? [];
          return confs.length > 0 ? Math.max(...confs) : 0;
        }),
      );
      const baseConf = 0.60;
      const boost = secondaryMinConf > 0.5 ? 0.15 : 0;
      const confidence = Math.min(baseConf + boost, 0.85);

      const evidence = [
        `${meaningfulSegments.length} segments`,
        ...distinctTypes.map(([type, count]) => `${type} in ${count}/${meaningfulSegments.length} segments`),
      ];

      return {
        type: 'mixed',
        confidence,
        evidence,
        secondary: secondary.map(([type, count]) => ({
          type: type as 'log' | 'code' | 'config' | 'error',
          confidence: 0.5,
          evidence: [`detected in ${count}/${meaningfulSegments.length} segments`],
        })),
      };
    },
  };
}
