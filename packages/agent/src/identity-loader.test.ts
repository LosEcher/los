import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

import {
  resolveAgentIdentity,
  resolveEffectiveIdentityLevel,
  formatIdentityForPrompt,
  type AgentIdentity,
  type IdentityLevel,
} from './identity-loader.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const TMP_DIR = join(__dirname, '../../.los-runtime', 'identity-test-' + Date.now());

// ── Cleanup ───────────────────────────────────────────────

function cleanup() {
  try { rmSync(TMP_DIR, { recursive: true, force: true }); } catch { /* ok */ }
}

test.beforeEach(cleanup);
test.after(cleanup);

// ── Resolution chain tests ─────────────────────────────────

test('resolveAgentIdentity returns built-in defaults when no file layer found', () => {
  const id = resolveAgentIdentity('default', '/nonexistent-workspace');
  assert.equal(id.name, 'los');
  assert.equal(id.role, 'Agent Execution Platform Operator');
  assert.ok(id.values && id.values.includes('precision'), 'values include precision');
  assert.ok(id.boundaries && id.boundaries.length >= 3, 'built-in boundaries present');
  assert.equal(id.level, 'standard', 'defaults to standard level');
});

test('resolveAgentIdentity picks child built-in for agent name child', () => {
  const id = resolveAgentIdentity('child', '/nonexistent-workspace');
  assert.equal(id.name, 'los-child');
  assert.equal(id.role, 'los child agent');
  assert.ok(id.boundaries && id.boundaries.some(b => b.includes('Do not spawn further')));
});

test('resolveAgentIdentity merges project-level override over built-in', () => {
  const projectDir = join(TMP_DIR, '.los', 'identity', 'default');
  mkdirSync(projectDir, { recursive: true });
  writeFileSync(join(projectDir, 'IDENTITY.md'), `---
name: project-los
style: cautious, thorough
---`);

  const id = resolveAgentIdentity('default', TMP_DIR);
  assert.equal(id.name, 'project-los', 'project-level name overrides built-in');
  assert.equal(id.style, 'cautious, thorough', 'project-level style overrides built-in');
  assert.equal(id.role, 'Agent Execution Platform Operator', 'role inherits from built-in');
});

test('resolveAgentIdentity resolution sources are tracked', () => {
  const id = resolveAgentIdentity('default', '/nonexistent-workspace');
  assert.equal(id.resolvedFrom.length, 3, 'three layers resolved');
  assert.equal(id.resolvedFrom[0].layer, 'system');
  assert.equal(id.resolvedFrom[1].layer, 'user');
  assert.equal(id.resolvedFrom[2].layer, 'project');
  // All 'found' should be false for nonexistent dirs
  assert.ok(id.resolvedFrom.every(s => !s.found), 'no identity files found from nonexistent dirs');
});

// ── Level resolution tests ─────────────────────────────────

test('resolveEffectiveIdentityLevel returns config when set', () => {
  assert.equal(resolveEffectiveIdentityLevel('minimal', 'standard'), 'minimal');
  assert.equal(resolveEffectiveIdentityLevel('full', 'standard'), 'full');
  assert.equal(resolveEffectiveIdentityLevel('none', 'standard'), 'none');
});

test('resolveEffectiveIdentityLevel falls back to default', () => {
  assert.equal(resolveEffectiveIdentityLevel(undefined, 'minimal'), 'minimal');
  assert.equal(resolveEffectiveIdentityLevel(undefined, 'none'), 'none');
});

// ── Prompt formatting tests ─────────────────────────────────

const SAMPLE_IDENTITY: AgentIdentity = {
  name: 'test-agent',
  role: 'Test Operator',
  style: 'direct, concise',
  values: ['honesty', 'precision'],
  temperament: 'systematic',
  boundaries: ['Never lie', 'Always verify'],
  heartbeat: 'Leave it better than you found it.',
  level: 'standard',
  resolvedFrom: [],
};

test('formatIdentityForPrompt returns empty string for none level', () => {
  const result = formatIdentityForPrompt(SAMPLE_IDENTITY, 'none');
  assert.equal(result, '');
});

test('formatIdentityForPrompt minimal returns role label only', () => {
  const result = formatIdentityForPrompt(SAMPLE_IDENTITY, 'minimal');
  assert.ok(result.startsWith('You are Test Operator'), `got: ${result.slice(0, 40)}`);
  assert.ok(!result.includes('## Identity'), 'minimal has no header section');
  assert.ok(!result.includes('Values'), 'minimal has no values');
});

test('formatIdentityForPrompt standard includes all core blocks', () => {
  const result = formatIdentityForPrompt(SAMPLE_IDENTITY, 'standard');
  assert.ok(result.includes('## Identity: test-agent'), 'includes name header');
  assert.ok(result.includes('**Role**: Test Operator'), 'includes role');
  assert.ok(result.includes('**Style**: direct, concise'), 'includes style');
  assert.ok(result.includes('**Values**: honesty, precision'), 'includes values');
  assert.ok(result.includes('**Temperament**: systematic'), 'includes temperament');
  assert.ok(result.includes('Never lie'), 'includes boundaries');
  assert.ok(result.includes('Leave it better than you found it'), 'includes heartbeat');
  assert.ok(!result.includes('## Background'), 'standard has no background narrative');
});

test('formatIdentityForPrompt standard respects explicit level param', () => {
  const idWithNone: AgentIdentity = { ...SAMPLE_IDENTITY, level: 'none' };
  const result = formatIdentityForPrompt(idWithNone, 'standard');
  assert.ok(result.includes('## Identity'), 'explicit level param wins over identity.level');
});

// ── ADR 0023 per-path decision matrix validation ───────────

test('ADR 0023: Gateway Chat path → standard identity', () => {
  // The decision matrix says Gateway Chat gets "standard"
  const id = resolveAgentIdentity('default', process.cwd());
  const prompt = formatIdentityForPrompt(id, 'standard');
  assert.ok(prompt.length > 50, 'standard identity prompt is substantial');
  assert.ok(prompt.includes('## Identity'), 'standard includes header');
  assert.ok(!prompt.includes('## Background'), 'standard excludes narrative');
});

test('ADR 0023: Child/Spawned path → minimal identity', () => {
  // Decision matrix: Child/Spawned → minimal
  const id = resolveAgentIdentity('child', process.cwd());
  const prompt = formatIdentityForPrompt(id, 'minimal');
  assert.ok(prompt.startsWith('You are los child agent'), `got: ${prompt.slice(0, 30)}`);
  assert.ok(!prompt.includes('## Identity'), 'minimal has no header section');
});

test('ADR 0023: Remote Executor path → minimal identity', () => {
  // Decision matrix: Remote Executor → minimal
  const id = resolveAgentIdentity('default', process.cwd());
  const prompt = formatIdentityForPrompt(id, 'minimal');
  assert.ok(prompt.startsWith('You are'), 'minimal identity is one line');
  assert.ok(!prompt.includes('## Identity'), 'minimal has no header');
});

test('ADR 0023: Scheduler Verifier path → none identity', () => {
  // Decision matrix: Verifier tasks must remain objective. identity = none.
  const id = resolveAgentIdentity('default', process.cwd());
  const prompt = formatIdentityForPrompt(id, 'none');
  assert.equal(prompt, '', 'verifier gets empty identity — no bias injection');
});

test('ADR 0023: Self-Check Judge path → none identity', () => {
  // Decision matrix: Judge uses different provider/model to avoid self-affirmation.
  // Identity = none.
  const id = resolveAgentIdentity('default', process.cwd());
  const prompt = formatIdentityForPrompt(id, 'none');
  assert.equal(prompt, '', 'judge gets empty identity — objective evaluator');
});

test('ADR 0023: Pre-Execution Phases → minimal identity', () => {
  // Decision matrix: Pre-Execution phases → minimal
  const id = resolveAgentIdentity('default', process.cwd());
  const prompt = formatIdentityForPrompt(id, 'minimal');
  assert.ok(prompt.startsWith('You are'), 'pre-execution gets one-line role label');
  assert.ok(!prompt.includes('Values'), 'minimal has no values');
});

// ── Edge cases ─────────────────────────────────────────────

test('formatIdentityForPrompt handles missing optional fields gracefully', () => {
  const minimalId: AgentIdentity = {
    name: 'bare',
    role: 'Bare Minimum',
    style: '',
    level: 'standard',
    resolvedFrom: [],
  };
  const prompt = formatIdentityForPrompt(minimalId);
  assert.ok(prompt.includes('bare'), 'includes name');
  assert.ok(prompt.includes('Bare Minimum'), 'includes role');
  // Should not crash on empty values/boundaries
  assert.ok(!prompt.includes('**Values**'), 'no values section when empty');
});

test('formatIdentityForPrompt full level includes soul narrative', () => {
  const fullId: AgentIdentity = {
    ...SAMPLE_IDENTITY,
    soulContent: 'This agent was forged in the fires of CI.',
    level: 'full',
  };
  const prompt = formatIdentityForPrompt(fullId, 'full');
  assert.ok(prompt.includes('## Background'), 'full level has Background section');
  assert.ok(prompt.includes('forged in the fires of CI'), 'includes soul narrative');
});
