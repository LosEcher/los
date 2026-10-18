import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createToolRegistry, registerBuiltinTools } from './registry.js';
import {
  assertCapabilityDeclaration,
  checkCapability,
  evaluateApprovalGate,
  evaluateScopeGate,
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
    () => assertCapabilityDeclaration('bad', capability({ scope: [], needsApproval: true, sideEffect: false, permissions: ['workspace:read'] })),
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
      { scope: [], needsApproval: true, sideEffect: false, permissions: ['workspace:read'] },
    ),
    /needsApproval requires sideEffect=true/,
  );
});

test('scope declaration must name a real parameter (A1b)', () => {
  const def = {
    type: 'function',
    function: {
      name: 'scoped_tool',
      description: 'test',
      parameters: { type: 'object', properties: { projectId: { type: 'string' } } },
    },
  } as const;
  assert.doesNotThrow(() => assertCapabilityDeclaration('scoped_tool', capability({ scope: ['projectId'] }), def));
  assert.throws(
    () => assertCapabilityDeclaration('scoped_tool', capability({ scope: ['sessionId'] }), def),
    /scope "sessionId" is not declared in parameters\.properties/,
  );
  assert.throws(
    () => assertCapabilityDeclaration('scoped_tool', capability({ scope: ['bogus' as never] }), def),
    /unknown scope id "bogus"/,
  );
  assert.throws(
    () => assertCapabilityDeclaration('scoped_tool', capability({ scope: ['projectId', 'projectId'] }), def),
    /duplicate scope id "projectId"/,
  );
});

test('registering a scope that the schema does not expose fails at registration', () => {
  const registry = createToolRegistry();
  assert.throws(
    () => registry.register(
      'scoped_tool',
      async () => ({ content: '' }),
      {
        type: 'function',
        function: {
          name: 'scoped_tool',
          description: 'no projectId parameter',
          parameters: { type: 'object', properties: { title: { type: 'string' } } },
        },
      },
      { scope: ['projectId'] },
    ),
    /scope "projectId" is not declared/,
  );
});

test('scope gate compares only ids the caller actually supplied', () => {
  const cap = capability({ scope: ['projectId'] });
  assert.deepEqual(evaluateScopeGate(cap, { projectId: 'other' }, { projectId: 'los' }), {
    mismatch: { scopeId: 'projectId', requested: 'other', context: 'los' },
  });
  assert.equal(evaluateScopeGate(cap, { projectId: 'los' }, { projectId: 'los' }), null);
  assert.equal(evaluateScopeGate(cap, {}, { projectId: 'los' }), null, 'omitted id defaults from context, not a violation');
  assert.deepEqual(evaluateScopeGate(cap, { projectId: 'x' }, {}), { contextMissing: 'projectId', requested: 'x' });
  assert.equal(evaluateScopeGate(capability({ scope: [] }), { projectId: 'x' }, { projectId: 'los' }), null);
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

test('a denied permission blocks the tool before it runs', () => {
  const capability = normalizeCapability('run_runtime_task', {
    riskLevel: 'L2',
    permissions: ['runtime:spawn'],
    sideEffect: true,
    needsApproval: false,
  });
  const decision = checkCapability(capability, { deniedPermissions: ['runtime:spawn'] });
  assert.equal(decision.allowed, false);
  assert.equal(decision.reasonCode, 'tool_permission_denied');
  assert.match(decision.reason, /runtime:spawn/);
});

test('a permission the run did not deny still passes', () => {
  const capability = normalizeCapability('run_shell', {
    riskLevel: 'L2',
    permissions: ['workspace:shell'],
    sideEffect: true,
    needsApproval: false,
  });
  const decision = checkCapability(capability, { deniedPermissions: ['runtime:spawn'] });
  assert.equal(decision.allowed, true);
});
