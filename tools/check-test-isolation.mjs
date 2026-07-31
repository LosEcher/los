#!/usr/bin/env node
/**
 * Static guard against cross-process test isolation races.
 *
 * CI runs @los/agent as three parallel LOS_TEST_GROUP processes sharing one
 * PostgreSQL. Schema isolation is handled by LOS_TEST_RUN_ID; this checker
 * catches filesystem races that have already bitten us:
 *   - fixed /tmp paths written then rmSync'd by a sibling process
 *   - module-level temp dirs keyed only by Date.now() (same-ms collision)
 *
 * Exit 0 when clean; exit 1 with paths when new violations appear.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const PACKAGES = join(ROOT, 'packages');

/** Exact substrings that already caused CI flakes — must stay gone. */
const FORBIDDEN_SUBSTRINGS = [
  // Fixed baseline path deleted by parallel agent group (run 420)
  "/tmp/los-mig-drift-test-baseline.txt",
  // Module-level dir with only Date.now() (run 415 ENOENT on IDENTITY.md)
  "identity-test-' + Date.now()",
  'identity-test-" + Date.now()',
  'identity-test-` + Date.now()',
];

/**
 * writeFileSync/rmSync/mkdirSync on a string-literal /tmp path without a
 * uniqueness marker. Missing-file probes (DOES-NOT-EXIST) are allowed.
 */
const FIXED_TMP_FS_CALL =
  /\b(?:writeFileSync|rmSync|mkdirSync|rmdirSync|unlinkSync|createWriteStream)\(\s*(['"`])(\/tmp\/[^'"`]+)\1/;

const UNIQUENESS_MARKERS = [
  'process.pid',
  'randomUUID',
  'randomBytes',
  'mkdtemp',
  'Date.now()',
  'DOES-NOT-EXIST',
  '${', // template interpolation usually includes pid/random
];

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist') continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path, out);
    else if (entry.name.endsWith('.test.ts') || entry.name.endsWith('.test.mjs')) out.push(path);
  }
  return out;
}

function lineOf(source, index) {
  return source.slice(0, index).split('\n').length;
}

function checkFile(path) {
  const source = readFileSync(path, 'utf8');
  const rel = relative(ROOT, path);
  const findings = [];

  for (const needle of FORBIDDEN_SUBSTRINGS) {
    const idx = source.indexOf(needle);
    if (idx !== -1) {
      findings.push({
        file: rel,
        line: lineOf(source, idx),
        rule: 'forbidden-substring',
        detail: needle,
      });
    }
  }

  // Module-scope temp path with only Date.now() (no pid/random/mkdtemp).
  // Nested (indented) consts inside tests are ignored — collision risk is
  // dominated by parallel processes loading the same module-level binding.
  const moduleDateOnly =
    /^(?:const|let|var)\s+\w+\s*=\s*[^\n]*(?:tmpdir\(\)|['"`]\/tmp\/|\.los-runtime)[^\n]*Date\.now\(\)[^\n]*;/gm;
  for (const match of source.matchAll(moduleDateOnly)) {
    const snippet = match[0];
    if (
      snippet.includes('process.pid')
      || snippet.includes('mkdtemp')
      || snippet.includes('Math.random')
      || snippet.includes('randomBytes')
      || snippet.includes('randomUUID')
    ) {
      continue;
    }
    findings.push({
      file: rel,
      line: lineOf(source, match.index ?? 0),
      rule: 'module-temp-date-only',
      detail: snippet.slice(0, 120),
    });
  }

  for (const match of source.matchAll(new RegExp(FIXED_TMP_FS_CALL, 'g'))) {
    const literal = match[2];
    const around = source.slice(Math.max(0, (match.index ?? 0) - 80), (match.index ?? 0) + match[0].length + 80);
    if (UNIQUENESS_MARKERS.some((m) => around.includes(m) || literal.includes('DOES-NOT-EXIST'))) {
      continue;
    }
    // Pure string literal /tmp/... with no uniqueness → race risk under parallel groups
    findings.push({
      file: rel,
      line: lineOf(source, match.index ?? 0),
      rule: 'fixed-tmp-fs-call',
      detail: `${match[0].slice(0, 80)} → ${literal}`,
    });
  }

  return findings;
}

function main() {
  const files = walk(PACKAGES);
  const findings = files.flatMap(checkFile);

  if (findings.length === 0) {
    console.log(`test-isolation: clean (${files.length} test files scanned)`);
    process.exit(0);
  }

  console.error(`test-isolation: ${findings.length} finding(s) in ${files.length} files`);
  for (const f of findings) {
    console.error(`  ${f.file}:${f.line}  [${f.rule}]  ${f.detail}`);
  }
  console.error(`
Remediation:
  - Temp dirs/files used with write/rm must include process.pid (or mkdtemp)
  - Never share a fixed /tmp path across LOS_TEST_GROUP processes
  - See packages/agent identity-loader + governance-auditors-migration tests
`);
  process.exit(1);
}

main();
