/**
 * @los/input-preprocessor/detectors/error-detector — Error/stack trace content type detector.
 *
 * Heuristics (evaluated in order, short-circuit on high-confidence match):
 * 1. Stack frame patterns: "at <func> (<file>:<line>:<col>)" (JS/TS)
 * 2. Cause chain markers: "Caused by:", "Suppressed:"
 * 3. Exception/panic keywords: "Error:", "Exception:", "panic:", "Traceback"
 * 4. Go goroutine dumps: "goroutine N [state]:"
 * 5. Python/Rust traceback patterns
 *
 * Confidence is boosted by stack frame density — more frames = more likely error dump.
 */

import type { ContentDetector } from './detector.js';
import type { ContentTypeDetection } from '../types.js';

// Stack frame patterns (language-specific).

/** JS/TS/Node: "    at async MyClass.myMethod (/app/src/foo.ts:42:15)" */
const JS_STACK_FRAME = /^\s*at\s+(?:async\s+)?\S+/m;

/** File location in stack frame: (file.ts:42:15) or file.ts:42:15 */
const FILE_LOCATION = /\(?[^\s()]+:\d+(?::\d+)?\)?/;

/** Java/C# "Caused by:" chain markers */
const CAUSE_CHAIN = /^\s*(?:Caused by|Suppressed|Wrapped by):\s/m;

/** Exception/error header keywords */
const EXCEPTION_HEADER =
  /\b(?:Error|Exception|panic|Panic|Fatal error|Uncaught exception|UnhandledPromiseRejection|Segmentation fault|SIGSEGV|SIGABRT|Stack trace):/m;

/** Python traceback: "Traceback (most recent call last):" */
const PYTHON_TRACEBACK = /^Traceback\s*\(most recent call last\):/m;

/** Python traceback file frames: '  File "/path/to/file.py", line 42, in <module>' */
const PYTHON_FRAME = /^\s+File\s+"[^"]+",\s+line\s+\d+,\s+in\s+\S+/m;

/** Go goroutine dumps: "goroutine 42 [running]:" or "goroutine 42 [IO wait]:" */
const GO_GOROUTINE = /^goroutine\s+\d+\s*\[.+\]:/m;

/** Rust panic: "thread 'main' panicked at src/main.rs:42:15:" */
const RUST_PANIC = /^thread\s+'[^']+'\s+panicked\s+at\s/m;

/** Minimum lines to attempt error detection. */
const MIN_LINES_FOR_DETECTION = 3;

/**
 * Create an error/stack trace content detector.
 * Pure function — no external state or configuration.
 */
export function createErrorDetector(): ContentDetector {
  return {
    name: 'error-detector',
    detect(input: string): ContentTypeDetection | null {
      const lines = input.split(/\r?\n/, 101);
      if (lines.length < MIN_LINES_FOR_DETECTION) return null;

      const first50 = lines.slice(0, Math.min(50, lines.length));
      const first100 = lines.slice(0, Math.min(100, lines.length));

      // Heuristic 1: JS/TS stack frame density.
      const jsFrames = first50.filter(l => JS_STACK_FRAME.test(l)).length;
      const jsFrameRatio = jsFrames / first50.length;
      if (jsFrameRatio >= 0.15) {
        return {
          type: 'error',
          confidence: 0.85 + jsFrameRatio * 0.1, // 0.85-0.95 range
          evidence: [`JS/TS stack frames in ${Math.round(jsFrameRatio * 100)}% of first ${first50.length} lines`],
        };
      }

      // Heuristic 2: Cause chain markers.
      if (CAUSE_CHAIN.test(input)) {
        // Boost confidence if we also see stack frames.
        const nearbyFrames = first100.filter(l => JS_STACK_FRAME.test(l)).length;
        const confidence = nearbyFrames > 0 ? 0.85 : 0.65;
        return {
          type: 'error',
          confidence,
          evidence: [
            'cause chain markers detected',
            nearbyFrames > 0 ? `${nearbyFrames} stack frames nearby` : 'no stack frames found',
          ],
        };
      }

      // Heuristic 3: Exception header keywords with evidence.
      const exceptionMatch = EXCEPTION_HEADER.exec(input);
      if (exceptionMatch) {
        // Check for supporting evidence: stack frames or file locations.
        const hasLocation = FILE_LOCATION.test(input);
        const hasStackFrame = JS_STACK_FRAME.test(input);
        const evidence: string[] = [`exception header: "${exceptionMatch[0]}"`];
        if (hasLocation) evidence.push('file locations detected');
        if (hasStackFrame) evidence.push('stack frames detected');

        const confidence = hasStackFrame ? 0.80 : (hasLocation ? 0.65 : 0.50);
        return { type: 'error', confidence, evidence };
      }

      // Heuristic 4: Python traceback.
      if (PYTHON_TRACEBACK.test(input)) {
        const pyFrames = first50.filter(l => PYTHON_FRAME.test(l)).length;
        const confidence = 0.75 + Math.min(pyFrames * 0.05, 0.2); // 0.75-0.95
        return {
          type: 'error',
          confidence,
          evidence: [`Python traceback with ${pyFrames} file frames`],
        };
      }

      // Heuristic 5: Go goroutine dump.
      if (GO_GOROUTINE.test(input)) {
        const goCount = first50.filter(l => GO_GOROUTINE.test(l)).length;
        return {
          type: 'error',
          confidence: 0.80 + Math.min(goCount * 0.05, 0.1), // 0.80-0.90
          evidence: [`Go goroutine dump: ${goCount} goroutine(s)`],
        };
      }

      // Heuristic 6: Rust panic.
      if (RUST_PANIC.test(input)) {
        return {
          type: 'error',
          confidence: 0.85,
          evidence: ['Rust panic with file location'],
        };
      }

      // Heuristic 7: Sparse file locations suggesting fragmented error output.
      const fileLocHits = first100.filter(l => FILE_LOCATION.test(l)).length;
      if (fileLocHits >= 5) {
        return {
          type: 'error',
          confidence: 0.45,
          evidence: [`${fileLocHits} file location references in first ${first100.length} lines`],
        };
      }

      return null;
    },
  };
}
