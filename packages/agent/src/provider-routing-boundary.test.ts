import test from 'node:test';
import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const packageRoot = resolve(import.meta.dirname, '..');
const workspaceRoot = resolve(packageRoot, '..', '..');

test('production provider routing uses compatibility fallback and health-aware selection', async () => {
  const setupSource = await readFile(resolve(packageRoot, 'src/loop/setup.ts'), 'utf-8');
  const selectionSource = await readFile(
    resolve(packageRoot, 'src/scheduler/provider-selection.ts'),
    'utf-8',
  );
  const probeSource = await readFile(
    resolve(packageRoot, 'src/providers/provider-probe.ts'),
    'utf-8',
  );
  const scheduledWorkSource = await readFile(
    resolve(packageRoot, 'src/scheduled-work/runner.ts'),
    'utf-8',
  );
  const packageManifest = JSON.parse(
    await readFile(resolve(packageRoot, 'package.json'), 'utf-8'),
  ) as { exports: Record<string, string> };
  const wiringBaseline = await readFile(resolve(workspaceRoot, 'tools/wiring-topology-baseline.txt'), 'utf-8');

  // Compatibility-gated fallback remains the production switch path.
  assert.match(setupSource, /prepareProviderFallbackPolicy/);
  assert.match(setupSource, /createProviderFallbackRouter/);
  assert.match(setupSource, /shouldSkipTarget/);
  assert.match(setupSource, /getCachedHealthScore|isUnhealthy/);

  // ADR 0031 health scoring is production-wired through graph task selection.
  assert.match(selectionSource, /computeHealthScore/);
  assert.match(selectionSource, /getCachedProbeResult/);
  assert.match(selectionSource, /healthScores/);

  // Probe loop is production-started from scheduler wake; no orphan probe entrypoints.
  assert.match(probeSource, /startProviderProbeLoop/);
  assert.match(probeSource, /export async function probeProviders/);
  assert.match(probeSource, /RTT_SMOOTH_ALPHA|0\.3/);
  assert.match(scheduledWorkSource, /startProviderProbeLoop/);
  assert.match(scheduledWorkSource, /stopProviderProbeLoop/);
  assert.match(scheduledWorkSource, /probeProviders/);
  assert.doesNotMatch(wiringBaseline, /provider-probe\.ts\|probeProviders  # zero callers/);
  assert.doesNotMatch(wiringBaseline, /provider-probe\.ts\|startProviderProbeLoop  # zero callers/);
  assert.doesNotMatch(wiringBaseline, /provider-probe\.ts\|stopProviderProbeLoop  # zero callers/);
  assert.doesNotMatch(wiringBaseline, /provider-health\.ts\|computeHealthScore  # zero callers/);
  assert.doesNotMatch(wiringBaseline, /provider-health\.ts\|isUnhealthy  # zero callers/);

  // Legacy affinity router stays deleted and unexported.
  assert.doesNotMatch(wiringBaseline, /route-healthy/);
  assert.equal(packageManifest.exports['./providers/route-healthy'], undefined);
  assert.equal(packageManifest.exports['./providers/provider-health'], undefined);
  await assert.rejects(access(resolve(packageRoot, 'src/providers/route-healthy.ts')));
});
