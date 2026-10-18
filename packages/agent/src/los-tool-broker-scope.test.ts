import test from 'node:test';
import assert from 'node:assert/strict';

import { createLosToolBroker } from './los-tool-broker.js';
import type { AgentConfig } from './loop/types.js';
import type { ToolCapability, ToolRegistry } from './tools/core/registry.js';
import { normalizeCapability } from './tools/core/registry-policy.js';

function scopedCapability(): ToolCapability {
  return normalizeCapability('todo_create', {
    scope: ['projectId', 'sessionId'],
    riskLevel: 'L1',
    permissions: ['todo:write'],
    sideEffect: true,
  });
}

function stubRegistry(executed: { count: number }): ToolRegistry {
  const capability = scopedCapability();
  return {
    register: () => undefined,
    execute: async () => {
      executed.count += 1;
      return { content: 'created' };
    },
    evaluateTool: () => ({ allowed: true, capability, policy: {} }),
    getDefinitions: () => [],
    getCapabilities: () => [capability],
    getCapability: () => capability,
    list: () => ['todo_create'],
  } as unknown as ToolRegistry;
}

function brokerInput(
  executed: { count: number },
  events: Record<string, unknown>[],
  config: Partial<AgentConfig> = { projectId: 'los', sessionId: 'session-a' },
  scopeEnforcement?: 'warn' | 'block',
) {
  return {
    tools: stubRegistry(executed),
    config: config as AgentConfig,
    signal: undefined,
    policy: { retry: {} } as never,
    emitEvent: async (event: Record<string, unknown>) => {
      events.push(event);
      return { id: 1 };
    },
    onSessionError: () => undefined,
    ...(scopeEnforcement ? { scopeEnforcement } : {}),
  };
}

test('scope mismatch is recorded as a warn event but the handler still runs (Slice 1)', async () => {
  const executed = { count: 0 };
  const events: Record<string, unknown>[] = [];
  const broker = createLosToolBroker(brokerInput(executed, events));

  const result = await broker.execute({
    callId: 'c1',
    name: 'todo_create',
    arguments: { title: 'x', projectId: 'other', sessionId: 'session-a' },
    turn: 1,
  });

  assert.equal(result.denied, false);
  assert.equal(executed.count, 1, 'warn mode must not block execution');
  const warned = events.find(event => event.type === 'tool.scope_mismatch');
  assert.ok(warned, 'expected a tool.scope_mismatch event');
  assert.deepEqual(warned!.payload, {
    callId: 'c1',
    mode: 'warn',
    action: 'warn',
    scopeId: 'projectId',
    requested: 'other',
    context: 'los',
  });
});

test('matching ids and absent ids produce no scope event', async () => {
  for (const args of [
    { title: 'x', projectId: 'los', sessionId: 'session-a' },
    { title: 'x' },
  ]) {
    const executed = { count: 0 };
    const events: Record<string, unknown>[] = [];
    const broker = createLosToolBroker(brokerInput(executed, events));
    const result = await broker.execute({ callId: 'c2', name: 'todo_create', arguments: args, turn: 1 });
    assert.equal(result.denied, false);
    assert.equal(events.some(event => event.type === 'tool.scope_mismatch'), false, JSON.stringify(args));
  }
});

test('missing context is reported separately, not silently treated as a match', async () => {
  const executed = { count: 0 };
  const events: Record<string, unknown>[] = [];
  const broker = createLosToolBroker(brokerInput(executed, events, {}));

  await broker.execute({
    callId: 'c3',
    name: 'todo_create',
    arguments: { title: 'x', projectId: 'other' },
    turn: 1,
  });

  const warned = events.find(event => event.type === 'tool.scope_mismatch');
  assert.deepEqual(warned?.payload, {
    callId: 'c3',
    mode: 'warn',
    action: 'warn',
    scopeId: 'projectId',
    requested: 'other',
    contextMissing: true,
  });
});

test('block mode refuses the call before the handler runs (A3 deny path)', async () => {
  const executed = { count: 0 };
  const events: Record<string, unknown>[] = [];
  const broker = createLosToolBroker(brokerInput(executed, events, undefined, 'block'));

  const result = await broker.execute({
    callId: 'c4',
    name: 'todo_create',
    arguments: { title: 'x', projectId: 'other' },
    turn: 1,
  });

  assert.equal(result.denied, true);
  assert.equal(executed.count, 0, 'the handler must not run when scope is enforced');
  assert.match(result.error ?? '', /outside the current run scope/);
  const warned = events.find(event => event.type === 'tool.scope_mismatch');
  assert.equal((warned?.payload as Record<string, unknown>).action, 'block');
  const denied = events.find(event => event.type === 'tool.denied');
  assert.equal((denied?.payload as Record<string, unknown>).reasonCode, 'tool_scope_mismatch');
});

test('block mode still executes when all declared ids match', async () => {
  const executed = { count: 0 };
  const events: Record<string, unknown>[] = [];
  const broker = createLosToolBroker(brokerInput(executed, events, undefined, 'block'));
  const result = await broker.execute({
    callId: 'c5',
    name: 'todo_create',
    arguments: { title: 'x', projectId: 'los' },
    turn: 1,
  });
  assert.equal(result.denied, false);
  assert.equal(executed.count, 1);
  assert.equal(events.some(event => event.type === 'tool.scope_mismatch'), false);
});
