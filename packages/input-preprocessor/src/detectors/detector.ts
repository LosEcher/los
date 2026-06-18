/**
 * @los/input-preprocessor/detectors/detector — Content detector interface.
 *
 * Detectors analyze raw text and return a ContentTypeDetection with confidence.
 * Multiple detectors can be composed; the highest-confidence result wins.
 */

import type { ContentTypeDetection } from '../types.js';

export interface ContentDetector {
  /** Analyze raw text and return detection result, or null if no match. */
  detect(input: string): ContentTypeDetection | null;
  /** Unique detector name for audit trails. */
  readonly name: string;
}

export type { ContentTypeDetection };
