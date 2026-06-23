/**
 * Governance auditor — static analysis audit.
 *
 * Runs los-ast scan against los's own source tree and reports findings
 * that can then be fed back into the governance todo system.
 *
 * Falls back gracefully if los-ast is not available (local dev without npm link).
 */
import { getLogger } from '@los/infra/logger';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const log = getLogger('governance-jobs');

interface StaticAnalysisFinding {
  ruleId: string;
  severity: 'error' | 'warning' | 'info';
  file: string;
  line?: number;
  message: string;
  governanceDomain?: string;
  impactHint?: string;
}

export async function runStaticAnalysisAudit(): Promise<Record<string, unknown>> {
  const findings: StaticAnalysisFinding[] = [];
  const workspaceRoot = process.cwd();

  // ── 1. Try los-ast CLI scan ──
  try {
    const losAstDir = resolve(workspaceRoot, '..', 'los-ast');
    if (existsSync(losAstDir)) {
      const { execSync } = await import('node:child_process');
      const scanOutput = execSync(
        `cd "${losAstDir}" && node ./packages/cli/src/index.mjs scan --root "${workspaceRoot}" --include "packages/**/*.ts" --ignore "**/node_modules/**" --ignore "**/dist/**" --ignore "**/*.test.*" --rules "rules/projects/lsclaw-governance/**/*.yml" --format jsonl 2>/dev/null || true`,
        { encoding: 'utf8', timeout: 60000, maxBuffer: 1024 * 1024 },
      );
      if (scanOutput.trim()) {
        for (const line of scanOutput.trim().split('\n')) {
          try {
            const finding = JSON.parse(line);
            const mapped: StaticAnalysisFinding = {
              ruleId: finding.ruleId ?? finding.id ?? 'unknown',
              severity: (finding.severity === 'error' ? 'error' : finding.severity === 'warning' ? 'warning' : 'info') as StaticAnalysisFinding['severity'],
              file: finding.file ?? finding.path ?? '',
              line: typeof finding.line === 'number' ? finding.line : undefined,
              message: finding.message ?? finding.title ?? '',
              governanceDomain: finding.governanceDomain ?? finding.domain,
              impactHint: finding.impactHint ?? finding.impact,
            };
            if (mapped.file) findings.push(mapped);
          } catch { /* skip malformed JSON lines */ }
        }
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // los-ast not available is expected in some environments
    if (!msg.includes('Command failed') || (msg.includes('los-ast') && msg.includes('not found'))) {
      log.warn(`Static analysis: los-ast scan skipped (${msg})`);
    }
  }

  // ── 2. Fallback: built-in ast-grep scan if los-ast not available ──
  try {
    if (findings.length === 0) {
      const { scanProject } = await import('./static-analysis/index.js');
      const result = await scanProject({
        project: 'los',
        rootDir: workspaceRoot,
        include: ['packages/**/*.ts'],
        ignore: ['**/node_modules/**', '**/dist/**', '**/*.test.*'],
      });
      for (const f of (result as any).findings ?? []) {
        findings.push({
          ruleId: f.ruleId ?? f.rule ?? 'unknown',
          severity: f.severity ?? 'warning',
          file: f.file ?? '',
          line: f.line,
          message: f.message ?? '',
          governanceDomain: f.governanceDomain,
          impactHint: f.impactHint,
        });
      }
    }
  } catch { /* built-in scanner may not be available; skip */ }

  // ── Summarize ──
  const errors = findings.filter(f => f.severity === 'error');
  const warnings = findings.filter(f => f.severity === 'warning');
  const infos = findings.filter(f => f.severity === 'info');
  const byDomain: Record<string, number> = {};
  for (const f of findings) {
    const domain = f.governanceDomain ?? 'uncategorized';
    byDomain[domain] = (byDomain[domain] ?? 0) + 1;
  }

  return {
    auditedAt: new Date().toISOString(),
    totalFindings: findings.length,
    errorCount: errors.length,
    warningCount: warnings.length,
    infoCount: infos.length,
    byDomain,
    topErrors: errors.slice(0, 10).map(f => ({ ruleId: f.ruleId, file: f.file, line: f.line, message: f.message })),
    topWarnings: warnings.slice(0, 10).map(f => ({ ruleId: f.ruleId, file: f.file, line: f.line, message: f.message })),
  };
}
