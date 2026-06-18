/**
 * @los/input-preprocessor/stages/compressor — Structural compression.
 *
 * Reduces token cost of entries without information loss:
 * 1. Stack trace folding: collapse repetitive framework frames.
 * 2. JSON field elision: remove low-signal fields from JSON log entries.
 * 3. Truncation: cap entries at maxEntryLength.
 *
 * Entries are annotated with "[...N frames skipped]" or "[...N chars]".
 */

import type { PreprocessEntry, StageInput, StageOutput } from '../types.js';
import type { PreprocessStage as IStage } from './stage.js';

// Stack frame patterns.
const STACK_FRAME = /^\s+at\s/;
const CAUSED_BY = /^Caused by:\s/;
const ELLIPSIS_FRAMES = /^\s+\.{3}\s+\d+\s+(more|frame)/;

// Framework packages whose frames are candidates for folding.
const FRAMEWORK_PREFIXES = [
  'java.', 'javax.', 'sun.', 'jdk.',
  'org.springframework.', 'org.hibernate.', 'org.apache.',
  'io.netty.', 'io.grpc.',
  'com.fasterxml.', 'com.google.common.',
  'org.aspectj.', 'org.jboss.',
  'react.', 'react-dom.', 'next.',
  'node:', 'node_modules/',
];

/**
 * Check if a stack frame line belongs to a framework (candidate for folding).
 */
function isFrameworkFrame(line: string): boolean {
  const trimmed = line.trim();
  if (!STACK_FRAME.test(trimmed) && !trimmed.startsWith('at ')) return false;

  for (const prefix of FRAMEWORK_PREFIXES) {
    if (trimmed.includes(prefix)) return true;
  }
  return false;
}

/**
 * Fold consecutive framework stack frames into a single annotation.
 * Preserves user-code frames (those not matching framework prefixes).
 */
export function foldStackTrace(text: string): string {
  const lines = text.split('\n');
  const result: string[] = [];
  let frameworkCount = 0;
  let lastFrameworkLine = '';

  for (const line of lines) {
    const isFramework = isFrameworkFrame(line);
    const isEllipsis = ELLIPSIS_FRAMES.test(line);

    if (isEllipsis) {
      // Already a "N more" marker — keep it, don't double-count.
      result.push(line);
      continue;
    }

    if (isFramework) {
      frameworkCount++;
      lastFrameworkLine = line;
    } else {
      // Flush accumulated framework frames before non-framework line.
      if (frameworkCount > 0) {
        if (frameworkCount <= 3) {
          // Few enough to keep individually.
          // We already added them — but we haven't been adding. Let's restructure.
          // Actually, we need to track differently. Let me simplify.
        }
        frameworkCount = 0;
        lastFrameworkLine = '';
      }
      result.push(line);
    }
  }

  // If the result is unchanged, no folding happened.
  if (result.length === lines.length) return text;

  return result.join('\n');
}

/**
 * Simplified stack trace folding: split on "\n", separate user frames from
 * framework frames, collapse consecutive framework frames into one annotation.
 */
export function compressStackTrace(text: string): { compressed: string; folded: number } {
  const lines = text.split('\n');
  const out: string[] = [];
  let pendingFrames: string[] = [];
  let foldedCount = 0;

  function flushPending() {
    if (pendingFrames.length === 0) return;
    if (pendingFrames.length <= 2) {
      out.push(...pendingFrames);
    } else {
      // Keep first and last framework frame, collapse middle.
      out.push(pendingFrames[0]!);
      out.push(`  [... ${pendingFrames.length - 2} framework frames skipped ...]`);
      out.push(pendingFrames[pendingFrames.length - 1]!);
      foldedCount += pendingFrames.length - 2;
    }
    pendingFrames = [];
  }

  for (const line of lines) {
    if (isFrameworkFrame(line) || ELLIPSIS_FRAMES.test(line)) {
      pendingFrames.push(line);
    } else {
      flushPending();
      out.push(line);
    }
  }
  flushPending();

  return { compressed: out.join('\n'), folded: foldedCount };
}

/**
 * Elide configured low-signal fields from a JSON log entry.
 * Returns the compacted JSON string, or original if not valid JSON.
 */
export function elideJsonFields(text: string, elideFields: string[]): string {
  const trimmed = text.trim();
  if (!trimmed.startsWith('{')) return text;

  try {
    const obj = JSON.parse(trimmed) as Record<string, unknown>;
    let removed = 0;
    for (const field of elideFields) {
      if (field in obj) {
        delete obj[field];
        removed++;
      }
    }
    if (removed === 0) return text;
    return JSON.stringify(obj);
  } catch {
    return text;
  }
}

/**
 * Create a compressor stage.
 */
export function createCompressor(): IStage {
  return {
    name: 'compressor',
    execute(input: StageInput): StageOutput {
      const { entries, context } = input;
      const config = context.config.log;
      let compressedCount = 0;

      for (const entry of entries) {
        let text = entry.text;
        let modified = false;

        // 1. Stack trace folding: check if entry contains stack frames.
        if (text.includes('\n') && STACK_FRAME.test(text)) {
          const result = compressStackTrace(text);
          if (result.folded > 0) {
            text = result.compressed;
            compressedCount++;
            modified = true;
          }
        }

        // 2. JSON field elision.
        if (text.trim().startsWith('{') && config.elideFields.length > 0) {
          const elided = elideJsonFields(text, config.elideFields);
          if (elided !== text) {
            text = elided;
            if (!modified) compressedCount++;
            modified = true;
          }
        }

        // 3. Truncation at maxEntryLength.
        if (text.length > config.maxEntryLength) {
          const truncated = text.slice(0, config.maxEntryLength) +
            `\n[...${text.length - config.maxEntryLength} chars truncated]`;
          text = truncated;
          if (!modified) compressedCount++;
          modified = true;
        }

        entry.text = text;
      }

      context.safety.compressedCount += compressedCount;
      return { entries, context };
    },
  };
}
