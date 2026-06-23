/**
 * Governance auditor — supply chain audit.
 *
 * Scans dependencies for:
 *   1. Install scripts in pnpm-lock.yaml that could be supply-chain risks
 *   2. Known CVEs via pnpm audit
 *   3. workspace:* references pointing to missing packages
 */
import { getLogger } from '@los/infra/logger';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const log = getLogger('governance-jobs');

interface SupplyChainFinding {
  kind: 'install_script' | 'cve' | 'workspace_missing' | 'audit_error';
  severity: 'critical' | 'high' | 'medium' | 'low';
  package?: string;
  version?: string;
  detail: string;
}

export async function runSupplyChainAudit(): Promise<Record<string, unknown>> {
  const findings: SupplyChainFinding[] = [];
  const workspaceRoot = process.cwd();

  // ── 1. Check for install scripts in locked dependencies ──
  try {
    const lockPath = resolve(workspaceRoot, 'pnpm-lock.yaml');
    if (existsSync(lockPath)) {
      const content = readFileSync(lockPath, 'utf8');
      // Detect packages with hasInstallScript: true
      const installScriptLines = content
        .split('\n')
        .filter(line => line.includes('hasInstallScript: true'));
      if (installScriptLines.length > 0) {
        // Extract package names from surrounding context
        const packagesWithScripts = new Set<string>();
        const lines = content.split('\n');
        for (let i = 0; i < lines.length; i++) {
          if (lines[i].includes('hasInstallScript: true')) {
            // Walk backwards to find the package name
            for (let j = i - 1; j >= Math.max(0, i - 15); j--) {
              const match = lines[j].match(/^\s*['"]?(@?[\w@./-]+)['"]?:$/);
              if (match && !match[1].startsWith('.')) {
                packagesWithScripts.add(match[1]);
                break;
              }
            }
          }
        }
        for (const pkg of packagesWithScripts) {
          findings.push({
            kind: 'install_script',
            severity: 'medium',
            package: pkg,
            detail: `Package "${pkg}" has an install script — review for supply-chain risk`,
          });
        }
      }
    }
  } catch (err) {
    log.warn(`Supply chain: lockfile scan failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  // ── 2. pnpm audit for known CVEs ──
  try {
    const { execSync } = await import('node:child_process');
    const auditOutput = execSync('pnpm audit --json 2>/dev/null || true', {
      cwd: workspaceRoot,
      encoding: 'utf8',
      timeout: 60000,
      maxBuffer: 1024 * 1024,
    });
    if (auditOutput.trim()) {
      try {
        const parsed = JSON.parse(auditOutput);
        const advisories = parsed.advisories ?? {};
        for (const [id, advisory] of Object.entries(advisories) as [string, any][]) {
          findings.push({
            kind: 'cve',
            severity: advisory.severity === 'critical' ? 'critical'
              : advisory.severity === 'high' ? 'high'
              : advisory.severity === 'moderate' ? 'medium'
              : 'low',
            package: advisory.module_name,
            version: advisory.findings?.[0]?.version,
            detail: `[${advisory.severity}] ${advisory.title} — ${advisory.url ?? id}`,
          });
        }
      } catch {
        // non-JSON output (e.g. human-readable summary) — not an error
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!msg.includes('Command failed') && !msg.includes('exit code')) {
      findings.push({ kind: 'audit_error', severity: 'low', detail: `pnpm audit failed: ${msg}` });
    }
    // pnpm audit exit code 1 just means "vulnerabilities found" — not a tool error
  }

  // ── 3. Check workspace:* references ──
  try {
    const rootPkgPath = resolve(workspaceRoot, 'package.json');
    if (existsSync(rootPkgPath)) {
      const rootPkg = JSON.parse(readFileSync(rootPkgPath, 'utf8'));
      const packagesDir = resolve(workspaceRoot, 'packages');
      for (const [depName, depVersion] of Object.entries<string>({
        ...(rootPkg.dependencies ?? {}),
        ...(rootPkg.devDependencies ?? {}),
      })) {
        if (depVersion === 'workspace:*' || depVersion.startsWith('workspace:')) {
          // Verify the package directory exists
          const expectedPath = resolve(packagesDir, depName.split('/').pop() ?? depName);
          if (!existsSync(expectedPath)) {
            findings.push({
              kind: 'workspace_missing',
              severity: 'high',
              package: depName,
              detail: `workspace dependency "${depName}" has no matching package directory`,
            });
          }
        }
      }
    }
  } catch (err) {
    log.warn(`Supply chain: workspace check failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  // ── Summarize ──
  const criticalFindings = findings.filter(f => f.severity === 'critical');
  const highFindings = findings.filter(f => f.severity === 'high');
  const mediumFindings = findings.filter(f => f.severity === 'medium');
  const lowFindings = findings.filter(f => f.severity === 'low');

  return {
    auditedAt: new Date().toISOString(),
    totalFindings: findings.length,
    criticalCount: criticalFindings.length,
    highCount: highFindings.length,
    mediumCount: mediumFindings.length,
    lowCount: lowFindings.length,
    installScriptPackages: findings.filter(f => f.kind === 'install_script').map(f => f.package),
    cveCount: findings.filter(f => f.kind === 'cve').length,
    workspaceMissing: findings.filter(f => f.kind === 'workspace_missing').map(f => f.package),
    // Top 5 most severe findings
    topFindings: [...criticalFindings, ...highFindings].slice(0, 5).map(f => ({
      severity: f.severity,
      package: f.package,
      detail: f.detail,
    })),
  };
}
