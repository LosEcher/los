/**
 * @los/input-preprocessor/detectors/config-detector — Configuration content type detector.
 *
 * Heuristics (evaluated in order):
 * 1. JSON structural detection (balanced braces + parse attempts)
 * 2. YAML key-value density (key: value patterns)
 * 3. INI/TOML section headers ([section])
 * 4. .env-style KEY=VALUE lines
 * 5. XML/HTML tag structure
 */

import type { ContentDetector } from './detector.js';
import type { ContentTypeDetection } from '../types.js';

// JSON: starts with { or [ and has balanced structure
const JSON_START = /^\s*[\[{]/;

// YAML key-value: "key: value" patterns (not "key:" followed by indented block)
const YAML_KV = /^[a-zA-Z_][\w.-]*\s*:\s+.+/;

// INI/TOML section: [section] or [section.sub]
const INI_SECTION = /^\[[\w.-]+\]/;

// .env-style: KEY=VALUE (no spaces around =)
const DOTENV_KV = /^[A-Z_][A-Z0-9_]*=.+/;

// XML/HTML tags
const XML_TAG = /<\/?\w+[^>]*>/;

// Minimum lines
const MIN_LINES = 3;

export function createConfigDetector(): ContentDetector {
  return {
    name: 'config-detector',
    detect(input: string): ContentTypeDetection | null {
      const lines = input.split(/\r?\n/, 101);
      if (lines.length < MIN_LINES) return null;

      const first50 = lines.slice(0, Math.min(50, lines.length));
      const nonEmpty = first50.filter(l => l.trim());

      // Heuristic 1: JSON detection.
      if (JSON_START.test(input)) {
        try {
          JSON.parse(input);
          return {
            type: 'config',
            confidence: 0.95,
            evidence: ['valid JSON structure'],
          };
        } catch {
          // Partial or malformed JSON — still likely config if it starts with { or [
          const braceOpen = (input.match(/\{/g) || []).length;
          const braceClose = (input.match(/\}/g) || []).length;
          const bracketOpen = (input.match(/\[/g) || []).length;
          const bracketClose = (input.match(/\]/g) || []).length;
          const hasJsonKeys = /"[a-zA-Z_]\w*"\s*:/.test(input);

          if (hasJsonKeys && braceOpen > 3) {
            return {
              type: 'config',
              confidence: 0.70,
              evidence: ['JSON-like structure with quoted keys'],
            };
          }
        }
      }

      // Heuristic 2: YAML key-value density.
      let yamlHits = 0;
      for (const line of first50) {
        if (YAML_KV.test(line.trim())) yamlHits++;
      }
      const yamlRatio = yamlHits / nonEmpty.length;
      if (yamlRatio >= 0.4 && nonEmpty.length >= 5) {
        return {
          type: 'config',
          confidence: 0.70 + yamlRatio * 0.25, // 0.70-0.90
          evidence: [`YAML key-value pairs in ${Math.round(yamlRatio * 100)}% of ${nonEmpty.length} non-empty lines`],
        };
      }

      // Heuristic 3: INI/TOML section headers.
      let sectionHits = 0;
      for (const line of first50) {
        if (INI_SECTION.test(line.trim())) sectionHits++;
      }
      if (sectionHits >= 1) {
        const evidence = [`${sectionHits} INI/TOML section header(s)`];
        if (yamlHits > 0) evidence.push(`${yamlHits} key-value pairs`);
        return {
          type: 'config',
          confidence: 0.75 + Math.min(sectionHits * 0.05, 0.1),
          evidence,
        };
      }

      // Heuristic 4: .env-style KEY=VALUE density.
      let envHits = 0;
      for (const line of first50) {
        if (DOTENV_KV.test(line.trim())) envHits++;
      }
      const envRatio = envHits / nonEmpty.length;
      if (envRatio >= 0.5 && envHits >= 3) {
        return {
          type: 'config',
          confidence: 0.75 + envRatio * 0.2, // 0.75-0.90
          evidence: [`.env-style KEY=VALUE in ${Math.round(envRatio * 100)}% of lines`],
        };
      }

      // Heuristic 5: XML/HTML structure.
      let xmlHits = 0;
      for (const line of first50) {
        if (XML_TAG.test(line) && /<\/?\w+/.test(line)) xmlHits++;
      }
      if (xmlHits >= 3) {
        return {
          type: 'config',
          confidence: 0.70,
          evidence: [`${xmlHits} XML/HTML tags detected`],
        };
      }

      // Heuristic 6: Sparse YAML-like with moderate confidence.
      if (yamlRatio >= 0.15 && nonEmpty.length >= 10) {
        return {
          type: 'config',
          confidence: 0.45,
          evidence: [`sparse key-value patterns (${Math.round(yamlRatio * 100)}%)`],
        };
      }

      return null;
    },
  };
}
