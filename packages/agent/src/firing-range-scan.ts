// Firing-range scanner: runs los static-analysis rules against pi and lsclaw.
// This is Phase 2 (靶场验证) of the los Bootstrap Capability Roadmap.
//
// Usage:
//   cd /Users/echerlos/projects/los-workspace/projects/los/packages/agent
//   node --import tsx --import ./src/test-setup.ts ./src/firing-range-scan.ts
//
// Outputs JSON reports to .los-runtime/firing-range/

import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { scanProject, loadRuleFiles } from './static-analysis/index.js';
import type { StaticAnalysisScanResult } from './static-analysis/types.js';

const REPO_ROOT = resolve(import.meta.dirname ?? process.cwd(), '..', '..');

const TARGETS: Array<{
  project: string;
  rootDir: string;
  include: string[];
}> = [
  {
    project: 'pi',
    rootDir: '/Users/echerlos/syncthing/project/pi',
    include: ['**/*.ts', '**/*.tsx', '**/*.js', '**/*.jsx', '**/*.mts', '**/*.mjs', '**/*.cjs', '**/*.cts'],
  },
  {
    project: 'lsclaw',
    rootDir: '/Users/echerlos/Downloads/projects/lsclaw',
    include: ['**/*.ts', '**/*.tsx', '**/*.js', '**/*.jsx', '**/*.mts', '**/*.mjs', '**/*.cjs', '**/*.cts'],
  },
];

const IGNORE = ['**/node_modules/**', '**/dist/**', '**/.git/**', '**/build/**', '**/.next/**'];

function summary(result: StaticAnalysisScanResult): string {
  const bySeverity: Record<string, number> = {};
  for (const f of result.findings) {
    bySeverity[f.severity] = (bySeverity[f.severity] ?? 0) + 1;
  }
  const byRule: Record<string, number> = {};
  for (const f of result.findings) {
    byRule[f.ruleId] = (byRule[f.ruleId] ?? 0) + 1;
  }
  const lines = [
    `  filesScanned: ${result.filesScanned}`,
    `  totalFindings: ${result.findings.length}`,
    `  bySeverity: ${JSON.stringify(bySeverity)}`,
    `  byRule: ${JSON.stringify(byRule)}`,
  ];
  if (result.parseFailures) {
    lines.push(`  parseFailures: ${result.parseFailures.count} (${JSON.stringify(result.parseFailures.byLanguage)})`);
  }
  return lines.join('\n');
}

async function main() {
  const ruleDirs = [
    join(process.cwd(), 'src/static-analysis/rules/languages/typescript/*.yml'),
    join(process.cwd(), 'src/static-analysis/rules/languages/javascript/*.yml'),
  ];

  console.log('Loading rules...');
  const rules = await loadRuleFiles(ruleDirs);
  console.log(`Loaded ${rules.length} rules: ${rules.map(r => r.id).join(', ')}`);

  const outDir = join(REPO_ROOT, '.los-runtime', 'firing-range');
  mkdirSync(outDir, { recursive: true });

  for (const target of TARGETS) {
    console.log(`\n=== Scanning ${target.project} (${target.rootDir}) ===`);
    const start = Date.now();
    const result = await scanProject({
      ...target,
      ignore: IGNORE,
      rules,
    });
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    console.log(summary(result));
    console.log(`  elapsed: ${elapsed}s`);

    const outPath = join(outDir, `${target.project}-scan.json`);
    writeFileSync(outPath, JSON.stringify(result, null, 2));
    console.log(`  -- wrote ${outPath}`);
  }

  console.log('\nDone. Reports in ' + outDir);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
