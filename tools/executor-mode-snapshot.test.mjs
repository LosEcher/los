import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  SENTINELS,
  parseEnvText,
  serializeSnapshot,
  snapshotFor,
  snapshotPath,
} from './executor-mode-snapshot.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..');
const tsx = join(repo, 'packages', 'infra', 'node_modules', '.bin', 'tsx');

const FIXTURES = {
  bomFirstLine: '\uFEFFDATABASE_URL=postgres://u:p@h/los\nEXECUTOR_DB_MODE=none\n',
  nbspIndent: '\u00a0\u00a0EXECUTOR_DB_MODE=none\nDATABASE_URL=\n',
  crlf: 'EXECUTOR_DB_MODE=none\r\nGATEWAY_URL="http://g:8080"\r\n',
  duplicateLastWins: 'EXECUTOR_DB_MODE=required\nEXECUTOR_DB_MODE=none\n',
  quoted: "EXECUTOR_TASK_TOKEN_MODE='required'\nGATEWAY_URL = \"http://g:8080\"\n",
  emptyQuotedDb: 'DATABASE_URL=""\nEXECUTOR_DB_MODE=none\n',
  comments: '# EXECUTOR_DB_MODE=none\n\nEXECUTOR_DB_MODE=required # not a comment\n',
  exportPrefix: 'export EXECUTOR_DB_MODE=none\nEXECUTOR_DB_MODE=required\n',
  inlineEquals: 'GATEWAY_URL=http://g:8080/?a=b\nEXECUTOR_DB_MODE=none\n',
};

function loadWithInfra(dir) {
  const probe = join(dir, 'probe.mts');
  writeFileSync(
    probe,
    `import { loadEnvFile } from ${JSON.stringify(join(repo, 'packages', 'infra', 'src', 'config-sources.ts'))};\n` +
      `process.stdout.write(JSON.stringify(loadEnvFile(process.argv[2])));\n`,
  );
  return JSON.parse(
    execFileSync(tsx, [probe, dir], { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }),
  );
}

test('parser matches loadEnvFile for BOM/NBSP/CRLF/quote/dup cases', { skip: !existsSync(tsx) }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'los-env-parity-'));
  try {
    for (const [name, content] of Object.entries(FIXTURES)) {
      writeFileSync(join(dir, '.env'), content);
      const expected = loadWithInfra(dir);
      assert.deepEqual(parseEnvText(content), expected, `fixture ${name}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('BOM-prefixed DATABASE_URL cannot hide behind the mode snapshot', () => {
  const snap = snapshotFor('\uFEFFDATABASE_URL=postgres://u:p@h/los\nEXECUTOR_DB_MODE=none\n');
  assert.equal(snap.EXECUTOR_DB_MODE, 'none');
  assert.equal(snap.DATABASE_URL, '<redacted>');
  assert.match(serializeSnapshot(snap), /^DATABASE_URL=<redacted>$/m);
});

test('empty and quoted-empty DATABASE_URL are absent', () => {
  assert.equal(snapshotFor('DATABASE_URL=\n').DATABASE_URL, '');
  assert.equal(snapshotFor('DATABASE_URL=""\n').DATABASE_URL, '');
  assert.equal(snapshotFor("DATABASE_URL=''\n").DATABASE_URL, '');
});

test('last assignment wins', () => {
  assert.equal(snapshotFor('EXECUTOR_DB_MODE=required\nEXECUTOR_DB_MODE=none\n').EXECUTOR_DB_MODE, 'none');
});

test('missing file and non-file produce distinct sentinels', () => {
  assert.equal(snapshotPath(join(tmpdir(), 'los-does-not-exist-env')), `${SENTINELS.missing}\n`);
  assert.equal(snapshotPath(tmpdir()), `${SENTINELS.notAFile}\n`);
});
