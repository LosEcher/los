import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadAllSpecs, resolveSpecLayer } from './spec-loader.js';

/** Spec loader must resolve specs from a workspace root other than los. */
test('loadAllSpecs loads specs from an explicit workspace root', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'los-spec-'));
  mkdirSync(join(tmp, '.los', 'spec'), { recursive: true });
  writeFileSync(join(tmp, '.los', 'spec', 'overview.md'), '# Project Overview\nexternal project');

  const specs = loadAllSpecs(tmp);
  const overview = specs.find(s => s.layer === 'overview');
  assert.ok(overview, 'overview spec should be loaded from external workspace');
  assert.equal(overview!.pkg, 'project');
  assert.match(overview!.content, /external project/);
});

/** When no los-style package specs exist, the generic walk discovers them. */
test('loadAllSpecs falls back to generic directory walk for non-los projects', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'los-spec-'));
  mkdirSync(join(tmp, '.los', 'spec', 'api'), { recursive: true });
  writeFileSync(join(tmp, '.los', 'spec', 'api', 'routes.md'), '# API Routes');

  const specs = loadAllSpecs(tmp);
  const apiSpec = specs.find(s => s.pkg === 'api');
  assert.ok(apiSpec, 'api pkg discovered via generic walk');
  assert.equal(apiSpec!.layer, 'routes');
  assert.match(apiSpec!.content, /API Routes/);
});

/** resolveSpecLayer accepts an explicit workspace root. */
test('resolveSpecLayer uses workspace root for spec path resolution', () => {
  const layer = resolveSpecLayer('packages/agent/src/loop.ts', '/some/workspace');
  assert.ok(layer);
  assert.equal(layer!.pkg, 'agent');
  assert.equal(layer!.layer, 'loop');
  assert.match(layer!.path, /\/some\/workspace\/\.los\/spec\/agent\/loop\/index\.md$/);
});

/** Without a workspace root, the los default is used (backward compat). */
test('resolveSpecLayer falls back to los default workspace when no root given', () => {
  const layer = resolveSpecLayer('packages/infra/src/config.ts');
  assert.ok(layer);
  assert.equal(layer!.pkg, 'infra');
  // The default workspace resolves to the los monorepo root.
  assert.match(layer!.path, /\.los\/spec\/infra\/index\.md$/);
});
