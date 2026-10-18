import test from 'node:test';
import assert from 'node:assert/strict';

import { createLosToolBroker } from './los-tool-broker.js';
import type { AgentConfig } from './loop/types.js';
import type { ToolCapability, ToolRegistry } from './tools/core/registry.js';
import { normalizeCapability } from './tools/core/registry-policy.js';

function shellCapability(): ToolCapability {
  return normalizeCapability('run_shell', {
    riskLevel: 'L2',
    permissions: ['workspace:shell'],
    sideEffect: true,
    sandboxRequired: true,
    needsApproval: true,
  });
}

function stubRegistry(executed: { count: number }): ToolRegistry {
  const capability = shellCapability();
  return {
    register: () => undefined,
    execute: async () => {
      executed.count += 1;
      return { content: 'ran' };
    },
    evaluateTool: () => ({ allowed: true, capability, policy: {} }),
    getDefinitions: () => [],
    getCapabilities: () => [capability],
    getCapability: () => capability,
    list: () => ['run_shell'],
  } as unknown as ToolRegistry;
}

function brokerInput(executed: { count: number }, events: Record<string, unknown>[], enforcement: 'warn' | 'block') {
  return {
    tools: stubRegistry(executed),
    config: {} as AgentConfig,
    signal: undefined,
    policy: { retry: {} } as never,
    emitEvent: async (event: Record<string, unknown>) => {
      events.push(event);
      return { id: 1 };
    },
    onSessionError: () => undefined,
    approvalEnforcement: enforcement,
  };
}

test('warn mode lets a needsApproval tool run but records the missing channel', async () => {
  const executed = { count: 0 };
  const events: Record<string, unknown>[] = [];
  const broker = createLosToolBroker(brokerInput(executed, events, 'warn'));

  const result = await broker.execute({ callId: 'c1', name: 'run_shell', arguments: {}, turn: 1 });

  assert.equal(result.denied, false);
  assert.equal(executed.count, 1);
  const warned = events.find(event => event.type === 'tool.approval_required');
  assert.ok(warned, 'expected a tool.approval_required event');
  assert.equal((warned!.payload as Record<string, unknown>).action, 'warn');
  assert.equal((warned!.payload as Record<string, unknown>).enforcementMode, 'warn');
});

test('block mode refuses a needsApproval tool before the handler runs', async () => {
  const executed = { count: 0 };
  const events: Record<string, unknown>[] = [];
  const broker = createLosToolBroker(brokerInput(executed, events, 'block'));

  const result = await broker.execute({ callId: 'c2', name: 'run_shell', arguments: {}, turn: 1 });

  assert.equal(result.denied, true);
  assert.match(result.error ?? '', /no approval channel is wired/);
  assert.equal(executed.count, 0, 'the handler must not run when approval is enforced');
  const blocked = events.find(event => event.type === 'tool.approval_required');
  assert.equal((blocked!.payload as Record<string, unknown>).action, 'block');
  const denied = events.find(event => event.type === 'tool.denied');
  assert.equal((denied!.payload as Record<string, unknown>).reasonCode, 'tool_approval_required');
});
