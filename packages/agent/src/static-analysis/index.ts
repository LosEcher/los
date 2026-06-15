import { discoverFiles } from './discover.js';
import { scanFiles } from './scanner.js';
import { summarizeParseFailures, deterministicSort } from './shared.js';
import type { StaticAnalysisScanOptions, StaticAnalysisScanResult } from './types.js';

export async function scanProject(
  options: StaticAnalysisScanOptions,
): Promise<StaticAnalysisScanResult> {
  const {
    project = 'custom',
    rootDir,
    include,
    ignore,
    rules = [],
    deterministic = false,
    signal,
  } = options;

  const files = await discoverFiles({ rootDir, include, ignore });

  const { findings, parseFailures } = await scanFiles(files, {
    project,
    rules,
    deterministic,
    signal,
  });

  if (deterministic) {
    findings.sort(deterministicSort);
  }

  const parseFailureSummary = summarizeParseFailures(parseFailures);

  const result: StaticAnalysisScanResult = {
    filesScanned: files.length,
    findings,
  };

  if (parseFailureSummary) {
    result.parseFailures = parseFailureSummary;
  }

  return result;
}

export { loadRuleFiles } from './rule-loader.js';
export { discoverFiles } from './discover.js';
export { scanFiles } from './scanner.js';
export { languageFromFilePath } from './languages.js';
export type * from './types.js';
