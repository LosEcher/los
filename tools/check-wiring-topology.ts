/**
 * tools/check-wiring-topology.ts
 *
 * Topology wiring verification across all los packages.
 * Detects "implemented but not wired" anti-pattern by checking:
 *   1. Exported functions with zero non-test callers (orphans)
 *   2. Route files not reachable from gateway/server.ts (extends check-unwired-exports.sh)
 *   3. ensure*Store functions not called from bootstrap or test setup
 *   4. Barrel-exported functions not imported by any non-test code
 *
 * Baseline-protected ratchet: existing orphans are grandfathered,
 * only NEW orphans block CI. Shrink baseline with --update-baseline.
 *
 * No DB needed — pure static grep/import analysis over source files.
 *
 * Run: node --import tsx ../../tools/check-wiring-topology.ts
 *      node --import tsx ../../tools/check-wiring-topology.ts --update-baseline
 * Exit: 0 = no new orphans, 1 = new orphans found
 */

import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, basename, dirname } from 'node:path';
import { execSync } from 'node:child_process';

const ROOT = new URL('..', import.meta.url).pathname;
const BASELINE_FILE = join(ROOT, 'tools', 'wiring-topology-baseline.txt');
const UPDATE_BASELINE = process.argv.includes('--update-baseline');
const VERBOSE = process.argv.includes('--verbose');

const PACKAGES_DIR = join(ROOT, 'packages');

// ── Entry-point callers (functions that define the "reachable surface") ──
// Functions defined in these files are treated as auto-reachable (they ARE the entry points).
const ENTRY_FILES = new Set([
  'packages/gateway/src/server.ts',
  'packages/gateway/src/chat-service.ts',
  'packages/cli/src/index.ts',
  'packages/executor/src/index.ts',
  'packages/agent/src/scheduler/scheduled-task-runner.ts',
  'packages/agent/src/governance-wake.ts',
]);

// Packages whose exports MUST be reachable from an entry point.
// test-setup files are also considered valid callers (they verify the module works).
const ALL_PACKAGES = ['agent', 'gateway', 'memory', 'executor', 'cli', 'infra'];

// ── Helpers ──────────────────────────────────────────────────

function log(...args: unknown[]) {
  if (VERBOSE) console.error(...args);
}

/** All .ts/.tsx source files under packages/ excluding node_modules and dist. */
function* sourceFiles(pkg?: string): Generator<string> {
  const base = pkg ? join(PACKAGES_DIR, pkg, 'src') : PACKAGES_DIR;
  if (!existsSync(base)) return;
  for (const entry of readdirSync(base, { recursive: true })) {
    const full = join(base, entry as string);
    if (!statSync(full).isFile()) continue;
    const rel = relative(ROOT, full);
    if (rel.includes('node_modules') || rel.includes('/dist/')) continue;
    if (!/\.tsx?$/.test(rel)) continue;
    if (rel.endsWith('.d.ts')) continue;
    yield rel;
  }
}

/** Extract exported function/const names from a file. */
function extractExports(filePath: string): Array<{ name: string; line: number }> {
  const abs = join(ROOT, filePath);
  if (!existsSync(abs)) return [];
  try {
    const content = readFileSync(abs, 'utf8');
    const out: Array<{ name: string; line: number }> = [];
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      // Match: export function name | export async function name | export const name =
      let m = line.match(/^export\s+(?:async\s+)?function\s+(\w+)/);
      if (!m) m = line.match(/^export\s+const\s+(\w+)\s*[:=]/);
      if (!m) m = line.match(/^export\s+class\s+(\w+)/);
      if (m) out.push({ name: m[1], line: i + 1 });
    }
    return out;
  } catch {
    return [];
  }
}

/** Check if a function name is called anywhere in non-test source files. */
function hasNonTestCaller(funcName: string, definingFile: string, allFiles: string[]): boolean {
  for (const caller of allFiles) {
    if (caller === definingFile) continue; // skip the defining file
    if (caller.endsWith('.test.ts') || caller.endsWith('.test.tsx')) continue;
    const abs = join(ROOT, caller);
    if (!existsSync(abs)) continue;
    try {
      const content = readFileSync(abs, 'utf8');
      // Match calls like: funcName( or funcName (
      // Explicitly exclude definition lines: export function funcName
      const callRegex = new RegExp(`\\b${escapeRegex(funcName)}\\s*\\(`, 'm');
      if (callRegex.test(content)) return true;
    } catch { /* skip */ }
  }
  return false;
}

/** Check if a function name is called from test files but no production files. */
function hasOnlyTestCallers(funcName: string, definingFile: string, allFiles: string[]): boolean {
  let testCaller = false;
  let nonTestCaller = false;
  for (const caller of allFiles) {
    if (caller === definingFile) continue;
    const abs = join(ROOT, caller);
    if (!existsSync(abs)) continue;
    try {
      const content = readFileSync(abs, 'utf8');
      const callRegex = new RegExp(`\\b${escapeRegex(funcName)}\\s*\\(`, 'm');
      if (callRegex.test(content)) {
        if (caller.endsWith('.test.ts') || caller.endsWith('.test.tsx')) {
          testCaller = true;
        } else {
          nonTestCaller = true;
        }
      }
    } catch { /* skip */ }
  }
  return testCaller && !nonTestCaller;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function pkgFromFile(filePath: string): string {
  const m = filePath.match(/^packages\/([^/]+)\//);
  return m ? m[1] : 'unknown';
}

/** All source files we'll search for callers. */
function allSourceFiles(): string[] {
  const files: string[] = [];
  for (const pkg of ALL_PACKAGES) {
    for (const f of sourceFiles(pkg)) {
      files.push(f);
    }
  }
  return files;
}

// ── Detectors ────────────────────────────────────────────────

interface OrphanEntry {
  /** Unique key for baseline: pkg|file|function */
  key: string;
  pkg: string;
  file: string;
  func: string;
  line: number;
  reason: string;
}

/** Find exported functions with no non-test callers. */
function detectOrphans(allFiles: string[]): OrphanEntry[] {
  const orphans: OrphanEntry[] = [];
  const exported = new Map<string, Array<{ name: string; line: number }>>();
  for (const f of allFiles) {
    const exps = extractExports(f);
    if (exps.length) exported.set(f, exps);
  }

  for (const [file, exps] of exported) {
    // Skip entry files — their exports are reachable by definition
    if (ENTRY_FILES.has(file)) continue;
    // Skip index.ts barrel files — they re-export, reachability is checked at the source
    if (basename(file) === 'index.ts') continue;

    for (const exp of exps) {
      // Skip internal/utility prefixes that are defined locally and not expected
      // to have remote callers (they're consumed within the same file or package).
      if (exp.name.startsWith('_')) continue;
      // Skip test-only exports (files containing 'test' or 'fixture' in name)
      if (/test|fixture|spec\.ts/.test(file)) continue;
      // Skip config/schema objects (export const X = { ... }) — these are data, not functions
      if (/Schema|Config|Pattern$/.test(exp.name)) continue;

      if (!hasNonTestCaller(exp.name, file, allFiles)) {
        const pkg = pkgFromFile(file);
        const key = `${pkg}|${file}|${exp.name}`;
        let reason: string;
        const onlyTests = hasOnlyTestCallers(exp.name, file, allFiles);
        if (onlyTests) {
          reason = 'test-only caller (no production caller)';
        } else {
          reason = 'zero callers (orphan)';
        }
        orphans.push({ key, pkg, file, func: exp.name, line: exp.line, reason });
      }
    }
  }
  return orphans;
}

/** Find route files in gateway/src/routes/ not imported by any gateway source. */
function detectUnwiredRoutes(allFiles: string[]): OrphanEntry[] {
  const orphans: OrphanEntry[] = [];
  const routesDir = join(ROOT, 'packages/gateway/src/routes');
  if (!existsSync(routesDir)) return orphans;

  const gatewayFiles = allFiles.filter(f => f.startsWith('packages/gateway/'));

  for (const rf of sourceFilesRecursive(routesDir)) {
    const rel = relative(ROOT, rf);
    if (rel.endsWith('.test.ts') || rel.endsWith('.d.ts')) continue;

    const stem = basename(rel, '.ts');
    const stemJs = stem + '.js';
    let imported = false;
    for (const gf of gatewayFiles) {
      if (gf === rel) continue;
      try {
        const content = readFileSync(join(ROOT, gf), 'utf8');
        if (content.includes(stemJs)) { imported = true; break; }
      } catch { /* skip */ }
    }
    if (!imported) {
      const pkg = 'gateway';
      const key = `${pkg}|${rel}|ROUTE_FILE`;
      orphans.push({ key, pkg, file: rel, func: 'ROUTE_FILE', line: 1, reason: 'route file not imported by any gateway source' });
    }
  }
  return orphans;
}

function* sourceFilesRecursive(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { recursive: true })) {
    const full = join(dir, entry as string);
    if (!statSync(full).isFile()) continue;
    yield full;
  }
}

/** Find ensure*Store functions NOT called from bootstrap.ts or a test setup file. */
function detectUnwiredEnsures(allFiles: string[]): OrphanEntry[] {
  const orphans: OrphanEntry[] = [];
  const bootstrap = allFiles.filter(f =>
    f.includes('bootstrap.ts') || f.includes('test-setup.ts')
  );

  for (const file of allFiles) {
    const exps = extractExports(file).filter(e => /^ensure[A-Z]/.test(e.name));
    for (const exp of exps) {
      // Check if called from bootstrap or test-setup
      let called = false;
      for (const bf of bootstrap) {
        try {
          const content = readFileSync(join(ROOT, bf), 'utf8');
          if (new RegExp(`\\b${escapeRegex(exp.name)}\\s*\\(`).test(content)) {
            called = true;
            break;
          }
        } catch { /* skip */ }
      }
      if (!called) {
        // Also check all source files for calls
        if (hasNonTestCaller(exp.name, file, allFiles)) continue;
        const pkg = pkgFromFile(file);
        const key = `${pkg}|${file}|${exp.name}`;
        orphans.push({ key, pkg, file, func: exp.name, line: exp.line, reason: 'ensure*Store not called from bootstrap or test-setup' });
      }
    }
  }
  return orphans;
}

// ── Main ─────────────────────────────────────────────────────

function main(): number {
  console.error('🔍 check-wiring-topology — scanning all packages for unwired exports...\n');

  const allFiles = allSourceFiles();
  log(`  source files: ${allFiles.length}`);

  // Run detectors
  const orphanExports = detectOrphans(allFiles);
  log(`  orphan exports: ${orphanExports.length}`);

  const unwiredRoutes = detectUnwiredRoutes(allFiles);
  log(`  unwired routes: ${unwiredRoutes.length}`);

  const unwiredEnsures = detectUnwiredEnsures(allFiles);
  log(`  unwired ensures: ${unwiredEnsures.length}`);

  const allFindings = [...orphanExports, ...unwiredRoutes, ...unwiredEnsures];
  // Sort for stable baseline
  allFindings.sort((a, b) => a.key.localeCompare(b.key));

  // Build the raw lines for baseline comparison
  const rawLines = allFindings.map(f => `${f.key}  # ${f.reason}`);

  // --update-baseline: write the current snapshot as the new baseline
  if (UPDATE_BASELINE) {
    writeFileSync(BASELINE_FILE, rawLines.join('\n') + (rawLines.length ? '\n' : ''));
    console.error(`✅ Baseline written: ${rawLines.length} entries → ${BASELINE_FILE}`);
    return 0;
  }

  // Load existing baseline
  let baseline = new Set<string>();
  try {
    baseline = new Set(readFileSync(BASELINE_FILE, 'utf8').split('\n').filter(Boolean).map(l => l.split('  #')[0].trim()));
  } catch {
    // No baseline yet — all findings are "new"
    console.error('⚠ No baseline file found. First run? All findings are new.\n');
  }

  const newFindings = allFindings.filter(f => !baseline.has(f.key));
  const fixedFindings = [...baseline].filter(bk => !allFindings.some(f => f.key === bk));

  let exitCode = 0;

  // Print report
  const byReason = new Map<string, OrphanEntry[]>();
  for (const f of newFindings) {
    const group = byReason.get(f.reason) || [];
    group.push(f);
    byReason.set(f.reason, group);
  }

  if (newFindings.length > 0) {
    exitCode = 1;
    console.error(`\n❌ NEW UNWIRED EXPORTS DETECTED (${newFindings.length}):\n`);

    for (const [reason, items] of byReason) {
      console.error(`  ${reason} (${items.length}):`);
      for (const item of items.slice(0, 10)) {
        console.error(`    ${item.file}:${item.line}  ${item.func}`);
      }
      if (items.length > 10) {
        console.error(`    ... and ${items.length - 10} more`);
      }
      console.error();
    }

    console.error('Fix: wire the export to an entry point or add it to the baseline.');
    console.error('  - For legitimate orphans (internal helpers): rename to _prefix or add to baseline.');
    console.error('  - For real unwired code: import and call it from the appropriate entry point.');
    console.error('  - To update baseline after fixing: node --import tsx ../../tools/check-wiring-topology.ts --update-baseline');
  } else {
    console.error(`✅ No NEW unwired exports (${allFindings.length} grandfathered, ${fixedFindings.length} fixed since baseline).`);
  }

  // Always print summary
  console.error(`\n  total: ${allFindings.length} findings | baseline: ${baseline.size} entries | new: ${newFindings.length} | fixed: ${fixedFindings.length}`);

  if (fixedFindings.length > 0 && exitCode === 0) {
    console.error(`  🎉 ${fixedFindings.length} entries fixed — run with --update-baseline to shrink the baseline.`);
  }

  // Print grandfathered entries in verbose mode
  if (VERBOSE && allFindings.length > 0) {
    console.error(`\n  Grandfathered findings (${allFindings.length}):`);
    for (const f of allFindings.slice(0, 30)) {
      console.error(`    [${f.pkg}] ${f.file}:${f.line}  ${f.func}  (${f.reason})`);
    }
    if (allFindings.length > 30) console.error(`    ... and ${allFindings.length - 30} more`);
  }

  return exitCode;
}

process.exitCode = main();
