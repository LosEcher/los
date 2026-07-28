import test from 'node:test';
import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const packageRoot = resolve(import.meta.dirname, '..');
const workspaceRoot = resolve(packageRoot, '..', '..');

test('production provider routing uses the compatibility-gated fallback path only', async () => {
  const setupSource = await readFile(resolve(packageRoot, 'src/loop/setup.ts'), 'utf-8');
  const packageManifest = JSON.parse(
    await readFile(resolve(packageRoot, 'package.json'), 'utf-8'),
  ) as { exports: Record<string, string> };
  const wiringBaseline = await readFile(resolve(workspaceRoot, 'tools/wiring-topology-baseline.txt'), 'utf-8');

  assert.match(setupSource, /prepareProviderFallbackPolicy/);
  assert.match(setupSource, /createProviderFallbackRouter/);
  assert.doesNotMatch(wiringBaseline, /provider-health|route-healthy/);
  assert.equal(packageManifest.exports['./providers/provider-health'], undefined);
  assert.equal(packageManifest.exports['./providers/route-healthy'], undefined);
  await Promise.all([
    assert.rejects(access(resolve(packageRoot, 'src/providers/provider-health.ts'))),
    assert.rejects(access(resolve(packageRoot, 'src/providers/route-healthy.ts'))),
  ]);
});
