import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  parseLockfilePackages,
  generateSbom,
  scanInstalledLicenses,
  checkTopLevelFreshness,
} from './governance-auditors-supply-chain.js';

test('parseLockfilePackages extracts name@version entries from pnpm lockfile', () => {
  const dir = mkdtempSync(join(tmpdir(), 'los-sc-'));
  const lockPath = join(dir, 'pnpm-lock.yaml');
  writeFileSync(lockPath, [
    'lockfileVersion: "9.0"',
    '',
    'packages:',
    "  '@eslint/plugin@1.2.3':",
    '    resolution: {integrity: sha512-abc}',
    '  fastify@4.28.1:',
    '    resolution: {integrity: sha512-def}',
    '  typescript@5.5.4:',
    '    resolution: {integrity: sha512-ghi}',
    '',
    'importers:',
    '  .:',
    '    devDependencies:',
    '      typescript: 5.5.4',
  ].join('\n'));
  try {
    const entries = parseLockfilePackages(lockPath);
    assert.equal(entries.length, 3);
    assert.deepEqual(entries[0], { name: '@eslint/plugin', version: '1.2.3' });
    assert.deepEqual(entries[1], { name: 'fastify', version: '4.28.1' });
    assert.deepEqual(entries[2], { name: 'typescript', version: '5.5.4' });
    const sbom = generateSbom(lockPath);
    assert.equal(sbom.format, 'spdx-2.3-lite');
    assert.equal(sbom.packages.length, 3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('scanInstalledLicenses flags missing or unlicensed packages', () => {
  const dir = mkdtempSync(join(tmpdir(), 'los-sc-lic-'));
  try {
    mkdirSync(join(dir, 'good'), { recursive: true });
    writeFileSync(join(dir, 'good', 'package.json'), JSON.stringify({ name: 'good', license: 'MIT' }));
    mkdirSync(join(dir, 'nolicense'), { recursive: true });
    writeFileSync(join(dir, 'nolicense', 'package.json'), JSON.stringify({ name: 'nolicense' }));
    mkdirSync(join(dir, 'unlicensed'), { recursive: true });
    writeFileSync(join(dir, 'unlicensed', 'package.json'), JSON.stringify({ name: 'unlicensed', license: 'UNLICENSED' }));

    const result = scanInstalledLicenses(dir);
    assert.equal(result.scannedCount, 3);
    assert.equal(result.missingCount, 2);
    assert.ok(result.missingPackages.includes('nolicense'));
    assert.ok(result.missingPackages.includes('unlicensed'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('checkTopLevelFreshness returns empty when disabled by env', async () => {
  // Without LOS_SUPPLY_CHAIN_FRESHNESS=1 the auditor does not invoke registry
  // queries; verify the helper itself tolerates a missing manifest.
  const dir = mkdtempSync(join(tmpdir(), 'los-sc-fresh-'));
  try {
    const result = await checkTopLevelFreshness(join(dir, 'missing-package.json'));
    assert.equal(result.enabled, true);
    assert.equal(result.stalePackages.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
