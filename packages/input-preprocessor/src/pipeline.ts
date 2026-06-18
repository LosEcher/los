/**
 * @los/input-preprocessor/pipeline — Main orchestrator.
 *
 * Flow:
 * 1. Content type detection (try all detectors, pick highest confidence).
 * 2. Route to type-specific denoiser.
 * 3. If confidence below threshold → passthrough.
 * 4. If unknown type → passthrough.
 * 5. Build final PreprocessedContent with metadata and safety report.
 */

import type {
  ContentType,
  PreprocessedContent,
  SafetyReport,
} from './types.js';
import type { ContentDetector } from './detectors/detector.js';
import { createLogDetector } from './detectors/log-detector.js';
import { createErrorDetector } from './detectors/error-detector.js';
import { createCodeDetector } from './detectors/code-detector.js';
import { createConfigDetector } from './detectors/config-detector.js';
import { createMixedDetector } from './detectors/mixed-detector.js';
import { denoiseLog } from './denoisers/log-denoiser.js';
import { denoiseError } from './denoisers/error-denoiser.js';
import { denoiseCode } from './denoisers/code-denoiser.js';
import { denoiseConfig } from './denoisers/config-denoiser.js';
import {
  createSafetyReport,
  shouldSkipProcessing,
  buildPassthroughOutput,
  buildSafetyHeader,
  estimateTokens,
  stripAnsi,
} from './safety.js';
import { resolveConfig } from './config.js';
import type { PreprocessorInput } from './types.js';
import type { ContentTypeDetection } from './types.js';

/**
 * Preprocess raw user input before sending to the LLM.
 *
 * Detects content type, applies type-specific denoising,
 * and returns optimized text with full safety audit trail.
 */
export function preprocessInput(input: PreprocessorInput): PreprocessedContent {
  const startTime = Date.now();
  const config = resolveConfig(input.config);

  // Check skip conditions.
  const skipReason = shouldSkipProcessing(
    input.rawText,
    config,
  );
  if (skipReason) {
    const passthrough = buildPassthroughOutput(input.rawText, skipReason, 'unknown');
    return {
      processedText: passthrough.processedText,
      metadata: {
        ...passthrough.metadata,
        processingTimeMs: Date.now() - startTime,
      },
      safetyReport: passthrough.safetyReport,
    };
  }

  // Stage 0: Strip ANSI escape codes before content detection.
  // Terminal-colored logs are common and ANSI codes confuse detectors.
  const cleanInput = stripAnsi(input.rawText);

  // Stage 1: Detect content type.
  const detectors = buildDetectors();
  const detection = detectContent(cleanInput, detectors);

  // Below confidence threshold → passthrough.
  if (!detection || detection.confidence < config.minConfidence) {
    const reason = detection
      ? `content type detection confidence (${detection.confidence}) below threshold (${config.minConfidence})`
      : 'no content type detected';
    const passthrough = buildPassthroughOutput(
      input.rawText, reason, detection?.type ?? 'unknown',
    );
    return {
      processedText: passthrough.processedText,
      metadata: {
        ...passthrough.metadata,
        contentType: (detection?.type ?? 'unknown') as ContentType,
        contentTypes: detection ? [detection.type] : ['unknown'],
        confidence: detection?.confidence ?? 0,
        evidence: detection?.evidence ?? [reason],
        processingTimeMs: Date.now() - startTime,
      },
      safetyReport: passthrough.safetyReport,
    };
  }

  // Route to type-specific denoiser.
  const safety = createSafetyReport();
  safety.originalTokenEstimate = estimateTokens(cleanInput);

  let processedText: string;

  switch (detection.type) {
    case 'log': {
      const result = denoiseLog(cleanInput, config, safety);
      processedText = result.processedText;
      break;
    }
    case 'error': {
      const result = denoiseError(cleanInput, config, safety);
      processedText = result.processedText;
      break;
    }
    case 'code': {
      const result = denoiseCode(cleanInput, config, safety);
      processedText = result.processedText;
      break;
    }
    case 'config': {
      const result = denoiseConfig(cleanInput, config, safety);
      processedText = result.processedText;
      break;
    }
    case 'mixed': {
      // Mixed content: apply best-fit denoiser per segment using blank-line splitting.
      // For now, apply the primary heuristic: if segments contain log+error → denoiseLog.
      // This is a simplified approach — full per-segment routing is P2.
      const hasLog = detection.secondary?.some(s => s.type === 'log');
      const hasError = detection.secondary?.some(s => s.type === 'error');
      if (hasLog || hasError) {
        const result = denoiseLog(cleanInput, config, safety);
        processedText = result.processedText;
      } else {
        // Mixed code+config or other: apply code denoiser (handles both reasonably).
        const result = denoiseCode(cleanInput, config, safety);
        processedText = result.processedText;
      }
      break;
    }
    default: {
      // Unknown type — passthrough with detection metadata.
      const reason = `unknown content type: ${detection.type}`;
      const passthrough = buildPassthroughOutput(input.rawText, reason, detection.type);
      return {
        processedText: passthrough.processedText,
        metadata: {
          ...passthrough.metadata,
          contentType: detection.type as ContentType,
          contentTypes: detection.secondary
            ? [detection.type as ContentType, ...detection.secondary.map(s => s.type)]
            : [detection.type as ContentType],
          confidence: detection.confidence,
          evidence: detection.evidence,
          processingTimeMs: Date.now() - startTime,
        },
        safetyReport: passthrough.safetyReport,
      };
    }
  }

  // Compute final token estimate and compression ratio.
  safety.finalTokenEstimate = estimateTokens(processedText);
  safety.compressionRatio = safety.originalTokenEstimate > 0
    ? safety.finalTokenEstimate / safety.originalTokenEstimate
    : 1;

  // Build safety header and prepend to output.
  const header = buildSafetyHeader(safety, detection.type);
  const finalText = header ? `${header}\n\n${processedText}` : processedText;

  const allTypes: ContentType[] = [detection.type];
  if (detection.secondary) {
    for (const s of detection.secondary) {
      if (!allTypes.includes(s.type)) allTypes.push(s.type);
    }
  }

  const processingTimeMs = Date.now() - startTime;

  // Emit audit event if hooks are provided (non-blocking).
  if (input.hooks?.onProcessed) {
    try {
      input.hooks.onProcessed({
        contentType: detection.type,
        contentTypes: allTypes,
        confidence: detection.confidence,
        originalLength: input.rawText.length,
        processedLength: finalText.length,
        tokenEstimate: safety.finalTokenEstimate,
        compressionRatio: safety.compressionRatio,
        warnings: safety.warnings,
        processingTimeMs,
      });
    } catch { /* hooks are best-effort */ }
  }

  return {
    processedText: finalText,
    metadata: {
      contentType: detection.type,
      contentTypes: allTypes,
      confidence: detection.confidence,
      evidence: detection.evidence,
      originalLength: input.rawText.length,
      processedLength: finalText.length,
      tokenEstimate: safety.finalTokenEstimate,
      processingTimeMs,
    },
    safetyReport: safety,
  };
}

// ---- Helpers ----

/**
 * Build the list of content detectors. Order matters:
 * mixed is run last because it needs other detectors' results.
 */
function buildDetectors(): ContentDetector[] {
  return [
    createLogDetector(),
    createErrorDetector(),
    createCodeDetector(),
    createConfigDetector(),
    createMixedDetector(),
  ];
}

/**
 * Run all detectors and return the highest-confidence result.
 * Returns null if no detector fires.
 */
function detectContent(
  input: string,
  detectors: ContentDetector[],
): ContentTypeDetection | null {
  let best: ContentTypeDetection | null = null;

  for (const detector of detectors) {
    const result = detector.detect(input);
    if (result && (!best || result.confidence > best.confidence)) {
      best = result;
    }
  }

  return best;
}
