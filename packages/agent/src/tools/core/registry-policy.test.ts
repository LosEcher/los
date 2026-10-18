import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createToolRegistry, registerBuiltinTools } from './registry.js';
import {
  assertCapabilityDeclaration,
  evaluateApprovalGate,
  normalizeCapability,
} from './registry-policy.js';

function capability(overrides: Parameters<typeof normalizeCapability>[1] = {}) {
  return normalizeCapability('test_tool', overrides);
}

test('approval gate allows tools that do not declare approval', () => {
  assert.deepEqual(evaluateApprovalGate(undefined, 'block'), { action: 'allow' });
  assert.deepEqual(evaluateApprovalGate(capability({ needsApproval: false }), 'block'), { action: 'allow' });
});

test('approval gate warns by default and names the missing channel', () => {
  const decision = evaluateApprovalGate(capability({ needsApproval: true, sideEffect: true, permissions: ['runtime:spawn'] }), 'warn');
  assert.equal(decision.action, 'warn');
  assert.match(decision.reason ?? '', /no approval channel is wired: test_tool/);
});

test('approval gate blocks in enforce mode', () => {
  const decision = evaluateApprovalGate(capability({ needsApproval: true, sideEffect: true, permissions: ['runtime:spawn'] }), 'block');
  assert.equal(decision.action, 'block');
  assert.match(decision.reason ?? '', /test_tool/);
});

test('a declaration that gates a read-only tool fails at boot', () => {
  assert.throws(
    () => assertCapabilityDeclaration('bad', capability({ needsApproval: true, sideEffect: false, permissions: ['workspace:read'] })),
    /needsApproval requires sideEffect=true/,
  );
});

test('a declaration with no permission fails at boot', () => {
  assert.throws(
    () => assertCapabilityDeclaration('bad', capability({ needsApproval: true, sideEffect: true, permissions: [] })),
    /needsApproval requires at least one permission/,
  );
});

test('registering a contradictory capability throws instead of storing it', () => {
  const registry = createToolRegistry();
  assert.throws(
    () => registry.register(
      'contradictory_tool',
      async () => ({ content: 'never runs' }),
      {
        type: 'function',
        function: {
          name: 'contradictory_tool',
          description: 'declares approval without a side effect',
          parameters: { type: 'object', properties: {} },
        },
      },
      { needsApproval: true, sideEffect: false, permissions: ['workspace:read'] },
    ),
    /needsApproval requires sideEffect=true/,
  );
});

test('every L2 builtin declares approval, a side effect, and a permission', async () => {
  const workspaceRoot = mkdtempSync(join(tmpdir(), 'los-capability-'));
  try {
    const registry = createToolRegistry();
    await registerBuiltinTools(registry, { workspaceRoot });
    const l2 = registry.getCapabilities().filter(cap => cap.riskLevel === 'L2');
    assert.ok(l2.length > 0, `expected at least one L2 builtin, got: ${registry.list().join(',')}`);
    for (const cap of l2) {
      assert.equal(cap.needsApproval, true, `${cap.name}: L2 must need approval`);
      assert.equal(cap.sideEffect, true, `${cap.name}: L2 must have a side effect`);
      assert.ok(cap.permissions.length > 0, `${cap.name}: L2 must declare a permission`);
    }
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
});
