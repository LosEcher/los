import assert from 'node:assert/strict';
import test from 'node:test';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, writeFileSync, unlinkSync } from 'node:fs';

import { loadRuleFiles } from './static-analysis/rule-loader.js';
import { discoverFiles } from './static-analysis/discover.js';
import { scanFiles } from './static-analysis/scanner.js';
import { scanProject } from './static-analysis/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
// __dirname = packages/agent/src, repoRoot = packages/agent
const repoRoot = resolve(__dirname, '../..');

test('loadRuleFiles loads YAML rules', async () => {
  const rulesDir = resolve(__dirname, './static-analysis/rules');
  const rules = await loadRuleFiles([`${rulesDir}/**/*.yml`]);

  assert.ok(rules.length >= 4, `expected >= 4 rules, got ${rules.length}`);

  for (const rule of rules) {
    assert.ok(typeof rule.id === 'string', `rule.id must be string: ${rule.id}`);
    assert.ok(typeof rule.language === 'string', `rule.language must be string`);
    assert.ok(typeof rule.message === 'string', `rule.message must be string`);
    assert.ok(typeof rule.rule === 'object' && rule.rule !== null, `rule.rule must be object`);
    assert.ok(
      ['error', 'warning', 'info'].includes(rule.severity),
      `rule.severity must be error|warning|info: ${rule.severity}`,
    );
    assert.ok(typeof rule.ruleFile === 'string', `rule.ruleFile must be set`);
  }
});

test('loadRuleFiles deduplicates by file path', async () => {
  const rulesDir = resolve(__dirname, './static-analysis/rules');
  const rules = await loadRuleFiles([
    `${rulesDir}/languages/typescript/*.yml`,
    `${rulesDir}/languages/typescript/*.yml`,
  ]);
  assert.equal(rules.length, 4, `expected 4 rules, got ${rules.length}`);
});

test('discoverFiles finds TypeScript files in agent src', async () => {
  const agentSrcDir = resolve(__dirname);
  const files = await discoverFiles({
    rootDir: agentSrcDir,
    include: ['**/*.ts'],
    ignore: ['**/node_modules/**'],
  });

  assert.ok(files.length >= 50, `expected >= 50 .ts files, got ${files.length}`);

  for (const f of files) {
    assert.ok(f.endsWith('.ts'), `file must be .ts: ${f}`);
    assert.ok(existsSync(f), `file must exist: ${f}`);
  }
});

test('scanFiles finds issues in a test fixture', async () => {
  const rulesDir = resolve(__dirname, './static-analysis/rules');
  const rules = await loadRuleFiles([`${rulesDir}/languages/typescript/*.yml`]);

  const tmpFile = resolve(__dirname, './static-analysis/__scan_test_fixture__.ts');

  writeFileSync(
    tmpFile,
    `const x: any = 1;\nconsole.log("test");\nconst y = x!;\n`,
    'utf8',
  );

  try {
    const { findings } = await scanFiles([tmpFile], { project: 'test', rules });

    const consoleLogFindings = findings.filter(
      (f) => f.ruleId === 'lang.typescript.no-console-log',
    );
    assert.ok(
      consoleLogFindings.length >= 1,
      `expected >= 1 console.log finding, got ${consoleLogFindings.length}`,
    );

    const anyFindings = findings.filter((f) => f.ruleId === 'lang.typescript.no-any');
    assert.ok(anyFindings.length >= 1, `expected >= 1 no-any finding, got ${anyFindings.length}`);

    const nonNullFindings = findings.filter(
      (f) => f.ruleId === 'lang.typescript.no-non-null-assertion',
    );
    assert.ok(
      nonNullFindings.length >= 1,
      `expected >= 1 non-null finding, got ${nonNullFindings.length}`,
    );

    for (const f of findings) {
      assert.ok(typeof f.fingerprint === 'string' && f.fingerprint.length > 0);
      assert.ok(typeof f.file === 'string');
      assert.ok(typeof f.message === 'string');
      assert.ok(typeof f.range === 'object');
      assert.ok(typeof f.range.start.line === 'number');
      assert.ok(typeof f.severity === 'string');
    }
  } finally {
    unlinkSync(tmpFile);
  }
});

test('scanProject integrates discover + scan', async () => {
  const rulesDir = resolve(__dirname, './static-analysis/rules');
  const rules = await loadRuleFiles([`${rulesDir}/languages/typescript/*.yml`]);

  const selfDir = resolve(__dirname, './static-analysis');
  const result = await scanProject({
    project: 'self-test',
    rootDir: selfDir,
    include: ['shared.ts'],
    rules,
    deterministic: true,
  });

  assert.ok(result.filesScanned >= 1);
  assert.ok(Array.isArray(result.findings));
  assert.ok(typeof result.filesScanned === 'number');
});

test('scanFiles handles empty file list', async () => {
  const { findings, parseFailures } = await scanFiles([], { project: 'empty' });
  assert.equal(findings.length, 0);
  assert.equal(parseFailures.length, 0);
});

test('scanFiles handles nonexistent file gracefully', async () => {
  const { findings, parseFailures } = await scanFiles(['/nonexistent/file.ts'], {
    project: 'test',
  });
  assert.equal(findings.length, 0);
  assert.ok(parseFailures.length >= 1);
});
