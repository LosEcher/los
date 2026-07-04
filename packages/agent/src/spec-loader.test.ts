import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadAllSpecs, loadSpecsForFiles, resolveSpecLayer, trimSpecForReview } from './spec-loader.js';

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

// ── Unit: trimSpecForReview ──

test('trimSpecForReview keeps checklist and quality sections', () => {
  const fullSpec = [
    '# agent/loop — ReAct Loop Spec',
    '',
    '## Pre-Development Checklist',
    '',
    '- [ ] Does the change affect the main agent loop?',
    '- [ ] Is this a phase-aware change?',
    '',
    '## Coding Guidelines',
    '',
    '### State Transitions',
    '- All state changes MUST go through transitionExecutionState()',
    '- Recovery paths are the only exception',
    '',
    '### B0 Enforcement',
    '- Scheduler MUST call canStartExecution()',
    '',
    '## Quality Check',
    '',
    '```bash',
    'pnpm check',
    'pnpm test',
    '```',
  ].join('\n');

  const trimmed = trimSpecForReview(fullSpec);
  assert.ok(trimmed.includes('Pre-Development Checklist'));
  assert.ok(trimmed.includes('Quality Check'));
  // Coding Guidelines should be stripped
  assert.ok(!trimmed.includes('State Transitions'), 'coding guidelines stripped');
  assert.ok(!trimmed.includes('B0 Enforcement'), 'coding guidelines stripped');
});

test('trimSpecForReview falls back to first chars when no recognized sections', () => {
  const plainText = 'This is a simple spec with no recognizable headings.\n' +
    'It just has some text.\n'.repeat(20);

  const trimmed = trimSpecForReview(plainText);
  assert.ok(trimmed.length < plainText.length, 'trimmed shorter than input');
  assert.ok(trimmed.includes('review mode'));
});

test('trimSpecForReview returns full content for short specs', () => {
  const short = '# Short Spec\n\nJust a line.';
  const trimmed = trimSpecForReview(short);
  assert.equal(trimmed, short, 'short content returned as-is');
});

test('loadSpecsForFiles review mode strips coding guidelines', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'los-spec-review-'));
  const specDir = join(tmp, '.los', 'spec', 'agent', 'loop');
  mkdirSync(specDir, { recursive: true });
  writeFileSync(join(specDir, 'index.md'), [
    '# agent/loop',
    '## Pre-Development Checklist',
    '- [ ] Item 1',
    '## Coding Guidelines',
    'Some guidelines here.',
    '## Quality Check',
    'pnpm check',
  ].join('\n'));

  // Need packages/ directory for resolveSpecLayer to work
  mkdirSync(join(tmp, 'packages', 'agent', 'src'), { recursive: true });

  const specs = loadSpecsForFiles(
    ['packages/agent/src/loop.ts'],
    tmp,
    { mode: 'review' },
  );

  assert.ok(specs.length > 0, 'should find at least one spec');
  const agentLoop = specs.find(s => s.layer === 'loop');
  assert.ok(agentLoop, 'agent/loop spec found');
  assert.ok(agentLoop!.content.includes('Pre-Development Checklist'));
  assert.ok(agentLoop!.content.includes('Quality Check'));
  assert.ok(!agentLoop!.content.includes('Coding Guidelines'), 'guidelines stripped in review mode');
});

test('loadSpecsForFiles full mode keeps all sections', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'los-spec-full-'));
  const specDir = join(tmp, '.los', 'spec', 'infra');
  mkdirSync(specDir, { recursive: true });
  writeFileSync(join(specDir, 'index.md'), [
    '# infra',
    '## Pre-Development Checklist',
    '- [ ] Item',
    '## Coding Guidelines',
    'Guidelines here.',
    '## Quality Check',
    'pnpm check',
  ].join('\n'));

  mkdirSync(join(tmp, 'packages', 'infra', 'src'), { recursive: true });

  const specs = loadSpecsForFiles(
    ['packages/infra/src/config.ts'],
    tmp,
    { mode: 'full' },
  );

  assert.ok(specs.length > 0);
  const infra = specs.find(s => s.pkg === 'infra');
  assert.ok(infra);
  assert.ok(infra!.content.includes('Coding Guidelines'), 'guidelines kept in full mode');
});
