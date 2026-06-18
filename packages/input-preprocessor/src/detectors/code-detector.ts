/**
 * @los/input-preprocessor/detectors/code-detector — Code content type detector.
 *
 * Heuristics (evaluated in order, short-circuit on high-confidence match):
 * 1. Shebang line: #!/usr/bin/env ... or #!... (high confidence)
 * 2. Import/require statement density (JS/TS/Python/Go/Rust/Java)
 * 3. Language keyword density (function, class, def, fn, struct, interface, etc.)
 * 4. Indentation consistency suggesting code blocks
 * 5. Comment-to-code ratio typical of source files
 */

import type { ContentDetector } from './detector.js';
import type { ContentTypeDetection } from '../types.js';

// Shebang: #! at very start of input
const SHEBANG = /^#!/;

// Import/require patterns across languages
const IMPORT_PATTERNS = [
  /^import\s+/m,               // JS/TS: import { ... }
  /^from\s+\S+\s+import\s+/m,  // Python: from X import Y
  /^(?:const|let|var)\s+\w+\s*=\s*require\(/m, // JS: const x = require(...)
  /^require\(/m,               // Lua/Ruby: require(...)
  /^use\s+\S+;/m,              // PHP/Rust: use Namespace\Class;
  /^#include\s*[<"]/m,         // C/C++: #include <...>
  /^package\s+\S+/m,           // Go/Java: package com.example
  /^extern\s+crate\s+/m,       // Rust: extern crate X
];

// Language keyword patterns — high density suggests code
const CODE_KEYWORDS = /\b(?:function|class|interface|struct|enum|impl|trait|def|async|await|const|let|var|return|yield|throw|try|catch|if|else|for|while|switch|case|break|continue|export|default|extends|implements|abstract|public|private|protected|static|final|void|int|string|bool|float|double|type|interface|namespace|module|fn|pub|mut|ref|unsafe|where|match)\b/;

// Comment patterns (single-line)
const LINE_COMMENT = /^\s*(\/\/|#|--|;)/;

// Minimum lines for detection
const MIN_LINES = 3;

export function createCodeDetector(): ContentDetector {
  return {
    name: 'code-detector',
    detect(input: string): ContentTypeDetection | null {
      const lines = input.split(/\r?\n/, 101);
      if (lines.length < MIN_LINES) return null;

      const first50 = lines.slice(0, Math.min(50, lines.length));

      // Heuristic 1: Shebang — near-certain code.
      if (SHEBANG.test(input)) {
        return {
          type: 'code',
          confidence: 0.98,
          evidence: ['shebang line detected'],
        };
      }

      // Heuristic 2: Import/require density.
      let importHits = 0;
      for (const line of first50) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        for (const pat of IMPORT_PATTERNS) {
          if (pat.test(trimmed)) {
            importHits++;
            break;
          }
        }
      }
      const importRatio = importHits / first50.length;
      if (importRatio >= 0.08) {
        return {
          type: 'code',
          confidence: 0.75 + importRatio * 1.5, // 0.75-0.95
          evidence: [`${importHits} import/require statements in first ${first50.length} lines`],
        };
      }

      // Heuristic 3: Code keyword density.
      let keywordHits = 0;
      let commentLines = 0;
      let nonEmptyLines = 0;
      for (const line of first50) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        nonEmptyLines++;
        if (CODE_KEYWORDS.test(trimmed)) keywordHits++;
        if (LINE_COMMENT.test(trimmed)) commentLines++;
      }
      const keywordRatio = nonEmptyLines > 0 ? keywordHits / nonEmptyLines : 0;
      const commentRatio = nonEmptyLines > 0 ? commentLines / nonEmptyLines : 0;

      if (keywordRatio >= 0.25 && nonEmptyLines >= 10) {
        const evidence = [
          `code keywords in ${Math.round(keywordRatio * 100)}% of ${nonEmptyLines} non-empty lines`,
        ];
        if (commentRatio >= 0.05) {
          evidence.push(`${Math.round(commentRatio * 100)}% comment lines`);
        }
        return {
          type: 'code',
          confidence: 0.65 + keywordRatio * 0.5, // 0.65-0.90
          evidence,
        };
      }

      // Heuristic 4: Indentation consistency + keyword hints.
      // Code files tend to have consistent leading whitespace.
      if (keywordRatio >= 0.10 && nonEmptyLines >= 20) {
        let indentedLines = 0;
        for (const line of first50) {
          if (/^[ \t]{2,}/.test(line)) indentedLines++;
        }
        const indentRatio = indentedLines / nonEmptyLines;
        if (indentRatio >= 0.3) {
          return {
            type: 'code',
            confidence: 0.55,
            evidence: [
              `${Math.round(keywordRatio * 100)}% keyword density`,
              `${Math.round(indentRatio * 100)}% indented lines`,
            ],
          };
        }
      }

      // Heuristic 5: High comment ratio with sparse keywords.
      if (commentRatio >= 0.15 && keywordRatio >= 0.08) {
        return {
          type: 'code',
          confidence: 0.45,
          evidence: [
            `${Math.round(commentRatio * 100)}% comment lines`,
            'sparse code keywords detected',
          ],
        };
      }

      return null;
    },
  };
}
