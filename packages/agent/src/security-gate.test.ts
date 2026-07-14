import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const securityGate = resolve(import.meta.dirname, '../../../tools/check-security.sh');

test('security gate rejects tracked env variants and expanded key names', () => {
  const fixture = mkdtempSync(resolve(tmpdir(), 'los-security-gate-'));
  try {
    mkdirSync(resolve(fixture, 'tools'));
    mkdirSync(resolve(fixture, 'src'));
    copyFileSync(securityGate, resolve(fixture, 'tools/check-security.sh'));
    writeFileSync(resolve(fixture, '.env.example'), 'SAFE_PLACEHOLDER=example\n');
    writeFileSync(resolve(fixture, '.env.local'), 'LOCAL_ONLY=value\n');
    writeFileSync(resolve(fixture, '.env.bak'), 'BACKUP=value\n');
    writeFileSync(resolve(fixture, 'service.env'), 'SERVICE=value\n');
    writeFileSync(
      resolve(fixture, 'src/config.ts'),
      [
        "const private_key = 'actual-private-value';",
        "const jwt_secret = 'actual-jwt-value';",
        "const encryption_key = 'actual-encryption-value';",
      ].join('\n'),
    );

    assert.equal(spawnSync('git', ['init', '-q'], { cwd: fixture }).status, 0);
    assert.equal(spawnSync('git', ['add', '.'], { cwd: fixture }).status, 0);
    const result = spawnSync('bash', ['tools/check-security.sh'], {
      cwd: fixture,
      encoding: 'utf8',
    });
    const output = `${result.stdout}${result.stderr}`;

    assert.equal(result.status, 1);
    assert.match(output, /\.env\.local is tracked by git/);
    assert.match(output, /\.env\.bak is tracked by git/);
    assert.match(output, /service\.env is tracked by git/);
    assert.doesNotMatch(output, /\.env\.example is tracked by git/);
    assert.match(output, /private_key/);
    assert.match(output, /jwt_secret/);
    assert.match(output, /encryption_key/);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});
