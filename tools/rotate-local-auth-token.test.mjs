import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  inspectLocalAuthToken,
  rotateLocalAuthToken,
} from './rotate-local-auth-token.mjs';

test('rotates local auth consumers and sanitizes gateway logs', () => {
  const root = mkdtempSync(join(tmpdir(), 'los-auth-rotation-'));
  const home = join(root, 'home');
  const oldToken = 'old-token-that-is-long-enough-for-test';
  const newToken = 'new-token-that-is-long-enough-for-test';

  try {
    mkdirSync(join(root, '.los-runtime'), { recursive: true });
    mkdirSync(join(home, '.weclaw'), { recursive: true });
    writeFileSync(join(root, '.env'), `LOS_AUTH_ENABLED=true\nLOS_AUTH_TOKEN=${oldToken}\nLOS_OPERATOR_TOKEN=operator-token\n`);
    writeFileSync(join(home, '.weclaw', 'config.json'), JSON.stringify({ agents: { los: { api_key: oldToken } } }));
    writeFileSync(
      join(root, '.los-runtime', 'gateway.log'),
      `headers={\"authorization\":\"Bearer ${oldToken}\",\"x-los-auth-token\":\"${oldToken}\"}\n`,
    );

    const before = inspectLocalAuthToken({ root, home });
    assert.equal(before.weclawMatches, true);
    assert.equal(before.sensitiveHeaderCount, 2);

    const result = rotateLocalAuthToken({ root, home, newToken });
    assert.equal(result.tokenLength, newToken.length);
    assert.match(readFileSync(join(root, '.env'), 'utf8'), new RegExp(`LOS_AUTH_TOKEN=${newToken}`));
    assert.equal(JSON.parse(readFileSync(join(home, '.weclaw', 'config.json'), 'utf8')).agents.los.api_key, newToken);

    const log = readFileSync(join(root, '.los-runtime', 'gateway.log'), 'utf8');
    assert.doesNotMatch(log, new RegExp(oldToken));
    assert.equal((log.match(/\[REDACTED_ROTATED\]/g) ?? []).length, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
