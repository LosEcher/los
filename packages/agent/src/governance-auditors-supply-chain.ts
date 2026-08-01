/**
 * Governance auditor — supply chain audit.
 *
 * Scans dependencies for:
 *   1. Install scripts in pnpm-lock.yaml that could be supply-chain risks
 *   2. Known CVEs via pnpm audit
 *   3. workspace:* references pointing to missing packages
 *   4. SPDX SBOM generation from pnpm-lock.yaml (offline)
 *   5. License compliance scan of installed packages (offline)
 *   6. Optional dependency freshness check (registry queries, off by default)
 */
import { getLogger } from '@los/infra/logger';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

const log = getLogger('governance-jobs');

interface SupplyChainFinding {
  kind: 'install_script' | 'cve' | 'workspace_missing' | 'audit_error' | 'stale_dependency';
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

  // ── 4. SPDX SBOM generation (offline, from the lockfile) ──
  const sbom = generateSbom(resolve(workspaceRoot, 'pnpm-lock.yaml'));

  // ── 5. License compliance scan (offline, installed packages) ──
  const licenseFindings = scanInstalledLicenses(resolve(workspaceRoot, 'node_modules'));

  // ── 6. Optional dependency freshness (registry queries, opt-in) ──
  const freshness = process.env.LOS_SUPPLY_CHAIN_FRESHNESS === '1'
    ? await checkTopLevelFreshness(resolve(workspaceRoot, 'package.json'))
    : { enabled: false, stalePackages: [] };
  for (const stale of freshness.stalePackages) {
    findings.push({
      kind: 'stale_dependency',
      severity: 'low',
      package: stale.name,
      version: stale.version,
      detail: `Dependency "${stale.name}"@${stale.version} last published ${stale.monthsSinceUpdate} months ago (>= 12 months threshold)`,
    });
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
    sbom: {
      format: sbom.format,
      packageCount: sbom.packages.length,
      packages: sbom.packages.slice(0, 50),
    },
    license: {
      scannedCount: licenseFindings.scannedCount,
      missingCount: licenseFindings.missingCount,
      missingPackages: licenseFindings.missingPackages.slice(0, 20),
    },
    freshness,
    // Top 5 most severe findings
    topFindings: [...criticalFindings, ...highFindings].slice(0, 5).map(f => ({
      severity: f.severity,
      package: f.package,
      detail: f.detail,
    })),
  };
}

// ── SBOM / license / freshness helpers ──────────────────────────

interface SbomEntry { name: string; version: string }

/** Parse pnpm-lock.yaml `packages:` entries into name@version pairs (offline). */
export function parseLockfilePackages(lockPath: string): SbomEntry[] {
  if (!existsSync(lockPath)) return [];
  const content = readFileSync(lockPath, 'utf8');
  const entries: SbomEntry[] = [];
  const lines = content.split('\n');
  for (const line of lines) {
    // pnpm v9 lockfile entries: "  'name@version':" or '  name@version:'
    const match = line.match(/^\s*['"]?(@?[^'"\s]+)['"]?:$/);
    if (!match) continue;
    const raw = match[1]!.trim();
    if (!raw.includes('@') || raw.startsWith('.') || raw.startsWith('/')) continue;
    // Split scoped names: @scope/name@version
    const atIndex = raw.lastIndexOf('@');
    if (atIndex <= 0) continue;
    const name = raw.slice(0, atIndex);
    const version = raw.slice(atIndex + 1);
    if (name && version && !version.includes('(')) {
      entries.push({ name, version });
    }
  }
  return entries;
}

export function generateSbom(lockPath: string): {
  format: string;
  packages: Array<{ name: string; version: string }>;
} {
  const packages = parseLockfilePackages(lockPath);
  return { format: 'spdx-2.3-lite', packages };
}

interface LicenseScanResult {
  scannedCount: number;
  missingCount: number;
  missingPackages: string[];
}

/** Scan installed top-level packages for a license field (offline). */
export function scanInstalledLicenses(nodeModulesPath: string): LicenseScanResult {
  const result: LicenseScanResult = { scannedCount: 0, missingCount: 0, missingPackages: [] };
  if (!existsSync(nodeModulesPath)) return result;
  let names: string[];
  try {
    names = readdirSync(nodeModulesPath).filter(name => !name.startsWith('.'));
  } catch {
    return result;
  }
  for (const name of names) {
    // Handle scoped packages: @scope/name → @scope directory with name inside
    const pkgJsonPath = name.startsWith('@')
      ? resolve(nodeModulesPath, name, name.split('/').pop()!, 'package.json')
      : resolve(nodeModulesPath, name, 'package.json');
    if (!existsSync(pkgJsonPath)) continue;
    try {
      const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf8'));
      result.scannedCount += 1;
      const license = pkg.license ?? pkg.licenses;
      const licenseOk = typeof license === 'string' && license !== 'UNLICENSED' && license !== 'SEE LICENSE IN LICENSE'
        || (Array.isArray(license) && license.length > 0);
      if (!licenseOk) {
        result.missingCount += 1;
        result.missingPackages.push(name);
      }
    } catch {
      // unreadable package.json — skip
    }
  }
  return result;
}

interface StalePackage { name: string; version: string; monthsSinceUpdate: number }

/** Freshness check against the npm registry; opt-in via LOS_SUPPLY_CHAIN_FRESHNESS=1. */
export async function checkTopLevelFreshness(rootPkgPath: string): Promise<{
  enabled: boolean;
  stalePackages: StalePackage[];
}> {
  const stalePackages: StalePackage[] = [];
  if (!existsSync(rootPkgPath)) return { enabled: true, stalePackages };
  const rootPkg = JSON.parse(readFileSync(rootPkgPath, 'utf8')) as Record<string, Record<string, string>>;
  const deps = { ...(rootPkg.dependencies ?? {}), ...(rootPkg.devDependencies ?? {}) };
  const names = Object.keys(deps).filter(name => !name.startsWith('@los/'));
  const STALE_MONTHS = 12;
  for (const name of names) {
    try {
      const response = await fetch(`https://registry.npmjs.org/${encodeURIComponent(name)}`, {
        headers: { Accept: 'application/vnd.npm.install-v1+json' },
        signal: AbortSignal.timeout(8_000),
      });
      if (!response.ok) continue;
      const body = await response.json() as { 'dist-tags'?: Record<string, string>; time?: Record<string, string> };
      const latest = body['dist-tags']?.latest;
      const publishedAt = latest ? body.time?.[latest] : undefined;
      if (!publishedAt) continue;
      const months = (Date.now() - Date.parse(publishedAt)) / (30 * 24 * 3600 * 1000);
      if (months >= STALE_MONTHS) {
        stalePackages.push({ name, version: latest ?? '', monthsSinceUpdate: Math.floor(months) });
      }
    } catch {
      // registry unreachable — skip silently (offline tolerance)
    }
  }
  return { enabled: true, stalePackages };
}
