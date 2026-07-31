#!/usr/bin/env bash
# check-static-analysis.sh — los scan (internal AST rules) gate.
#
# Hard gate on ERROR-severity findings only. warning/info counts are printed
# for the record but never block: the current baseline is 4.2k findings across
# 1.2k files, all warning/info style debt tracked for batch reduction.
#
# Uses the in-repo static-analysis module (packages/agent/src/static-analysis),
# NOT the legacy los-ast project — that capability was internalized 2026-06-15.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

SCAN_JSON=$(mktemp "${TMPDIR:-/tmp}/los-static-analysis.XXXXXX.json")
trap 'rm -f -- "$SCAN_JSON"' EXIT

# bin/los delegates to `pnpm --filter @los/cli exec tsx`, whose cwd is
# packages/cli — so --root/--rules are expressed relative to packages/cli.
if ! ./bin/los scan \
  --root ../.. \
  --rules "../agent/src/static-analysis/rules/**/*.yml" \
  --json > "$SCAN_JSON" 2>/dev/null; then
  printf '    %blos scan failed to run — check tsx/@los/cli availability%b\n' "$RED" "$NC"
  exit 1
fi

node - "$SCAN_JSON" <<'EOF'
const fs = require('node:fs');
const result = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const findings = result.findings || [];
const errors = findings.filter((f) => f.severity === 'error');
const warnings = findings.filter((f) => f.severity === 'warning').length;
const infos = findings.filter((f) => f.severity === 'info').length;

console.log(`    Files scanned: ${result.filesScanned}`);
console.log(`    Findings: error=${errors.length} warning=${warnings} info=${infos}`);

if (errors.length > 0) {
  console.log('    Blocking ERROR findings (use transitionExecutionState / fix root cause):');
  for (const f of errors) {
    const rel = f.file.replace(process.cwd() + '/', '');
    console.log(`      [error] ${f.ruleId} — ${rel}`);
    if (f.excerpt) console.log(`        >>> ${f.excerpt.split('\n')[0]}`);
  }
  process.exit(1);
}
EOF
