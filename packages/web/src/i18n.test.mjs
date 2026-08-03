import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const SRC = fileURLToPath(new URL('.', import.meta.url));

function readDict(lang) {
  const dict = {};
  const dir = new URL(`./i18n/${lang}/`, import.meta.url);
  for (const file of readdirSync(dir).filter(f => f.endsWith('.ts') && f !== 'index.ts')) {
    const src = readFileSync(new URL(file, dir), 'utf8');
    for (const m of src.matchAll(/^\s*'([^']+)':\s*("((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'),\s*$/gm)) {
      dict[m[1]] = m[3] ?? m[4];
    }
  }
  return dict;
}

function listSourceFiles(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (entry === 'i18n' || entry === 'node_modules' || entry === 'dist' || entry === 'test-results' || entry === 'e2e') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) listSourceFiles(full, out);
    else if ((entry.endsWith('.ts') || entry.endsWith('.tsx')) && !entry.endsWith('.test.mjs')) out.push(full);
  }
  return out;
}

const EN = readDict('en');
const ZH = readDict('zh');

test('en and zh dictionaries have identical key sets', () => {
  const enKeys = Object.keys(EN).sort();
  const zhKeys = Object.keys(ZH).sort();
  const missingInZh = enKeys.filter(k => !(k in ZH));
  const extraInZh = zhKeys.filter(k => !(k in EN));
  assert.deepEqual(missingInZh, [], `keys missing from zh dict: ${missingInZh.join(', ')}`);
  assert.deepEqual(extraInZh, [], `keys only in zh dict: ${extraInZh.join(', ')}`);
  assert.equal(enKeys.length, zhKeys.length, 'key count mismatch');
});

test('dictionary values are non-empty and follow key prefixes', () => {
  for (const [key, value] of Object.entries(EN)) {
    assert.ok(value.trim().length > 0, `empty en value for ${key}`);
    assert.match(key, /^(nav|common|status|chat|work|pages|ops|assets)\./, `unexpected key prefix: ${key}`);
  }
  for (const [key, value] of Object.entries(ZH)) {
    assert.ok(value.trim().length > 0, `empty zh value for ${key}`);
  }
});

test('zh placeholders are a subset of en placeholders per key', () => {
  const placeholders = (value) => [...value.matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort();
  for (const key of Object.keys(EN)) {
    const enSet = placeholders(EN[key]);
    const zhSet = placeholders(ZH[key]);
    const extra = zhSet.filter(p => !enSet.includes(p));
    assert.deepEqual(extra, [], `zh placeholder(s) missing in en for ${key}: ${extra.join(', ')}`);
  }
});

test('every static t()/tt() call site resolves in both dictionaries', () => {
  const files = listSourceFiles(dirname(SRC));
  assert.ok(files.length > 10, `expected many source files, found ${files.length}`);
  const missing = new Set();
  const found = new Set();
  for (const file of files) {
    const src = readFileSync(file, 'utf8');
    for (const m of src.matchAll(/\bt\('([^']+)'|\btt\('([^']+)'/g)) {
      const key = m[1] ?? m[2];
      found.add(key);
      if (!(key in EN)) missing.add(`${file}:${key} (missing from en)`);
      if (!(key in ZH)) missing.add(`${file}:${key} (missing from zh)`);
    }
  }
  assert.ok(found.size > 200, `expected many t() call sites, found ${found.size}`);
  assert.deepEqual([...missing], [], `unresolved keys:\n${[...missing].join('\n')}`);
});

test('lang switcher and storage keys are wired in the app shell', () => {
  const main = readFileSync(new URL('./main.tsx', import.meta.url), 'utf8');
  const app = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8');
  const i18n = readFileSync(new URL('./i18n/index.tsx', import.meta.url), 'utf8');
  assert.match(main, /<I18nProvider>/);
  assert.match(app, /className="lang-switch"/);
  assert.match(app, /setLang\(l\)/);
  assert.match(i18n, /localStorage\.getItem\(STORAGE_KEY\)/);
  assert.match(i18n, /document\.documentElement\.lang/);
});
