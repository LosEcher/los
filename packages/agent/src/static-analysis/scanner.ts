import type { Rule as AstGrepRule } from '@ast-grep/napi';
import fs from 'node:fs/promises';

import { languageFromFilePath, languageName, parseSource, type LangKey } from './languages.js';
import {
  clampExcerpt,
  fingerprintFor,
  passesConstraints,
  renderReplacement,
  toIsoNow,
} from './shared.js';
import type { StaticAnalysisFinding, StaticAnalysisRule } from './types.js';

function buildScanFinding({
  project,
  rule,
  file,
  language,
  node,
  deterministic,
}: {
  project: string;
  rule: StaticAnalysisRule;
  file: string;
  language: string;
  node: { range: () => { start: { line: number; column: number; index: number }; end: { line: number; column: number; index: number } }; text: () => string; getMatch: (name: string) => { text: () => string } | null; getMultipleMatches: (name: string) => Array<{ text: () => string }> };
  deterministic: boolean;
}): StaticAnalysisFinding {
  const hasFix = Boolean(rule.fix?.replace);
  const proposedReplacement = hasFix
    ? renderReplacement(rule.fix!.replace, node, rule.fix!.joinBy)
    : null;

  const range = node.range();
  const governanceDomain = rule.governance?.domain || null;
  const impactHint = rule.governance?.impact || null;
  const fingerprint = fingerprintFor({
    ruleId: rule.id,
    file,
    range,
    proposedReplacement,
    deterministic,
  });

  return {
    tool: 'los-static-analysis',
    version: 0,
    timestamp: toIsoNow(deterministic),
    project,
    ruleFile: rule.ruleFile || null,
    ruleId: rule.id,
    findingSource: 'ast',
    governanceDomain,
    impactHint,
    severity: rule.severity,
    message: rule.message,
    file,
    language,
    range,
    excerpt: clampExcerpt(node.text()),
    hasFix,
    proposedReplacement,
    fingerprint,
  };
}

export async function scanFiles(
  files: string[],
  options: {
    project?: string;
    rules?: StaticAnalysisRule[];
    deterministic?: boolean;
    signal?: AbortSignal;
  } = {},
): Promise<{
  findings: StaticAnalysisFinding[];
  parseFailures: Array<{ file: string; language: string; error: string }>;
}> {
  const { project = 'custom', rules = [], deterministic = false, signal } = options;

  const findings: StaticAnalysisFinding[] = [];
  const parseFailures: Array<{ file: string; language: string; error: string }> = [];

  for (const file of files) {
    if (signal?.aborted) {
      const err = new Error('Scan cancelled');
      err.name = 'AbortError';
      throw err;
    }

    const lang = languageFromFilePath(file);
    if (!lang) continue;

    let root: { findAll: (config: { rule: AstGrepRule }) => Array<{ range: () => { start: { line: number; column: number; index: number }; end: { line: number; column: number; index: number } }; text: () => string; getMatch: (name: string) => { text: () => string } | null; getMultipleMatches: (name: string) => Array<{ text: () => string }> }> };
    try {
      const source = await fs.readFile(file, 'utf8');
      const sgRoot = parseSource(lang, source);
      root = sgRoot.root();
    } catch (error) {
      parseFailures.push({
        file,
        language: languageName(lang),
        error: error instanceof Error ? error.message : String(error),
      });
      continue;
    }

    for (const rule of rules) {
      if (rule.language !== languageName(lang)) continue;

      try {
        const nodes = root.findAll({ rule: rule.rule as AstGrepRule });
        for (const node of nodes) {
          if (!passesConstraints(node, rule.constraints)) continue;
          findings.push(
            buildScanFinding({ project, rule, file, language: languageName(lang), node, deterministic }),
          );
        }
      } catch {
        // Rule failed to match — skip silently (rules may have syntax incompatible with ast-grep's pattern matching)
      }
    }
  }

  return { findings, parseFailures };
}
