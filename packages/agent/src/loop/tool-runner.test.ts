/**
 * Focused tests for parallel tool runner behavior.
 *
 * Covers:
 *  1. Parallelizable tools execute concurrently (overlapping wall-clock time)
 *  2. Non-parallelizable / mutating tools flush the preceding batch
 *  3. Result order matches input order regardless of completion order
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import type { ToolRegistry, ToolCapability, ToolResult, ToolExecutionDecision } from '../tools/core/registry-policy.js';
import type { ToolDef, ToolCall, Message } from '../providers/index.js';
import type { AgentConfig } from './types.js';
import { resolveToolPolicy } from './tool-resolver.js';

// ── Helpers ─────────────────────────────────────────────

type Resolver = ReturnType<typeof resolveToolPolicy>;

function mockEmitEvent(): () => void {
  return () => {};
}

const DUMMY_TC_STUB: ToolCall = {
  id: '',
  type: 'function' as const,
  function: { name: '', arguments: '{}' },
};

/**
 * Build a minimal mock ToolRegistry where each tool's execution timing
 * is controlled via a Map of name -> sleep-ms-before-result.
 * `parallelizable` capability is controlled per-tool.
 */
function mockRegistry(
  tools: Array<{ name: string; parallelizable: boolean; sleepMs: number; onExec?: (name: string) => void; sideEffect?: boolean }>,
): ToolRegistry & { executionOrder: string[] } {
  const order: string[] = [];
  const exe = new Map(tools.map(t => [t.name, t]));

  return {
    executionOrder: order,
    register() {},
    list(): string[] { return [...exe.keys()]; },
    getDefinitions(): ToolDef[] { return []; },
    getCapabilities(): ToolCapability[] {
      return tools.map(t => ({
        name: t.name,
        inputSchema: {},
        permissions: [],
        riskLevel: 'L0' as const,
        timeoutMs: 10_000,
        retryable: false,
        idempotent: !t.sideEffect,
        parallelizable: t.parallelizable,
        costLevel: 'low' as const,
        sideEffect: t.sideEffect ?? false,
        sandboxRequired: false,
        needsApproval: false,
        tags: [],
      }));
    },
    getCapability(name: string): ToolCapability | null {
      const t = exe.get(name);
      if (!t) return null;
      return this.getCapabilities().find(c => c.name === name) ?? null;
    },
    evaluateTool(name: string): ToolExecutionDecision {
      const cap = this.getCapability(name);
      if (!cap) return { allowed: false, reasonCode: 'tool_capability_missing', reason: 'not found', policy: {} };
      return { allowed: true, capability: cap, policy: {} };
    },
    async execute(input: { name: string; arguments: Record<string, unknown> }): Promise<ToolResult> {
      const t = exe.get(input.name)!;
      t.onExec?.(input.name);
      order.push(input.name);
      await new Promise(r => setTimeout(r, t.sleepMs));
      return { content: `result:${input.name}` };
    },
  };
}

function tc(callId: string, name: string, args: Record<string, unknown> = {}): ToolCall {
  return {
    id: callId,
    type: 'function',
    function: { name, arguments: JSON.stringify(args) },
  };
}

function buildPolicy(): Resolver {
  return {
    maxRiskLevel: 'L2',
    allowWrites: true,
    sandboxAvailable: false,
    retry: { maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0 },
  };
}

function buildConfig(overrides?: Partial<AgentConfig>): AgentConfig {
  return {
    defaultProvider: 'test',
    defaultModel: 'test-model',
    maxLoops: 1,
    sandboxMode: 'workspace-write' as const,
    runContractMetadata: undefined as any,
    reviewRoles: undefined as any,
    mcpServers: [],
    ...overrides,
  } as AgentConfig;
}

// ── Tests ───────────────────────────────────────────────

test('parallelizable tools execute concurrently (overlapping wall-clock)', async () => {
  const registry = mockRegistry([
    { name: 'read_file', parallelizable: true, sleepMs: 80 },
    { name: 'search_content', parallelizable: true, sleepMs: 80 },
    { name: 'glob', parallelizable: true, sleepMs: 80 },
  ]);
  const { runToolCalls } = await import('./tool-runner.js');

  const start = Date.now();
  const result = await runToolCalls({
    toolCalls: [tc('a', 'read_file'), tc('b', 'search_content'), tc('c', 'glob')],
    turn: 1,
    tools: registry,
    config: buildConfig(),
    signal: undefined,
    policy: buildPolicy(),
    emitEvent: mockEmitEvent as any,
    onSessionError: () => {},
  });
  const elapsed = Date.now() - start;

  // All three executed
  assert.equal(result.toolResults.length, 3);
  assert.ok(result.toolResults[0].includes('result:read_file'));
  assert.ok(result.toolResults[1].includes('result:search_content'));
  assert.ok(result.toolResults[2].includes('result:glob'));

  // Concurrent execution means wall-clock < sum of sleep times (80+80+80=240)
  // with some overhead tolerance — should be well under 200ms for truly parallel
  assert.ok(elapsed < 200, `Expected concurrent exec <200ms, got ${elapsed}ms`);
});

test('non-parallelizable tool flushes preceding parallel batch', async () => {
  const registry = mockRegistry([
    { name: 'read_file', parallelizable: true, sleepMs: 50 },
    { name: 'search_content', parallelizable: true, sleepMs: 50 },
    { name: 'write_file', parallelizable: false, sleepMs: 50, sideEffect: true },
    { name: 'glob', parallelizable: true, sleepMs: 50 },
  ]);
  const { runToolCalls } = await import('./tool-runner.js');

  const start = Date.now();
  const result = await runToolCalls({
    toolCalls: [tc('a', 'read_file'), tc('b', 'search_content'), tc('c', 'write_file'), tc('d', 'glob')],
    turn: 1,
    tools: registry,
    config: buildConfig(),
    signal: undefined,
    policy: buildPolicy(),
    emitEvent: mockEmitEvent as any,
    onSessionError: () => {},
  });
  const elapsed = Date.now() - start;

  assert.equal(result.toolResults.length, 4);

  // write_file must execute AFTER read_file and search_content complete
  // (it flushes the batch before executing)
  // glob executes after write_file in its own batch
  // Wall clock: batch(50) + write(50) + glob(50) ≈ 150 serialized
  // vs pure parallel which would be ~50
  assert.ok(elapsed > 100, `Expected serialized due to mutating tool >100ms, got ${elapsed}ms`);

  // Execution order must respect: batch1(parallel) → write_file → glob
  const idx = (name: string) => registry.executionOrder.indexOf(name);
  assert.ok(idx('read_file') >= 0);
  assert.ok(idx('search_content') >= 0);
  assert.ok(idx('write_file') > idx('read_file'), 'write_file must execute after read_file');
  assert.ok(idx('write_file') > idx('search_content'), 'write_file must execute after search_content');
  assert.ok(idx('glob') > idx('write_file'), 'glob must execute after write_file');
});

test('result order matches input order regardless of completion order', async () => {
  // Three parallelizable tools with different sleep times — completions will be out of natural order
  const registry = mockRegistry([
    { name: 'fast', parallelizable: true, sleepMs: 10 },
    { name: 'slow', parallelizable: true, sleepMs: 80 },
    { name: 'medium', parallelizable: true, sleepMs: 40 },
  ]);
  const { runToolCalls } = await import('./tool-runner.js');

  const result = await runToolCalls({
    toolCalls: [tc('a', 'fast'), tc('b', 'slow'), tc('c', 'medium')],
    turn: 1,
    tools: registry,
    config: buildConfig(),
    signal: undefined,
    policy: buildPolicy(),
    emitEvent: mockEmitEvent as any,
    onSessionError: () => {},
  });

  assert.equal(result.toolResults.length, 3);
  // Results must be in input order: fast, slow, medium
  assert.ok(result.toolResults[0].includes('result:fast'), `got: ${result.toolResults[0]}`);
  assert.ok(result.toolResults[1].includes('result:slow'), `got: ${result.toolResults[1]}`);
  assert.ok(result.toolResults[2].includes('result:medium'), `got: ${result.toolResults[2]}`);
});

test('mixed parallel and non-parallel tools produce correct tool messages', async () => {
  const registry = mockRegistry([
    { name: 'read_file', parallelizable: true, sleepMs: 10 },
    { name: 'write_file', parallelizable: false, sleepMs: 10, sideEffect: true },
    { name: 'search_content', parallelizable: true, sleepMs: 10 },
  ]);
  const { runToolCalls } = await import('./tool-runner.js');

  const result = await runToolCalls({
    toolCalls: [tc('r1', 'read_file'), tc('w1', 'write_file'), tc('s1', 'search_content')],
    turn: 1,
    tools: registry,
    config: buildConfig(),
    signal: undefined,
    policy: buildPolicy(),
    emitEvent: mockEmitEvent as any,
    onSessionError: () => {},
  });

  assert.equal(result.toolMessages.length, 3);
  assert.equal(result.toolMessages[0].role, 'tool');
  assert.equal(result.toolMessages[0].tool_call_id, 'r1');
  assert.equal(result.toolMessages[1].tool_call_id, 'w1');
  assert.equal(result.toolMessages[2].tool_call_id, 's1');
});

test('empty tool calls produce empty results', async () => {
  const registry = mockRegistry([]);
  const { runToolCalls } = await import('./tool-runner.js');

  const result = await runToolCalls({
    toolCalls: [],
    turn: 1,
    tools: registry,
    config: buildConfig(),
    signal: undefined,
    policy: buildPolicy(),
    emitEvent: mockEmitEvent as any,
    onSessionError: () => {},
  });

  assert.equal(result.toolResults.length, 0);
  assert.equal(result.toolMessages.length, 0);
});

test('all non-parallelizable tools each execute sequentially', async () => {
  const registry = mockRegistry([
    { name: 'write_a', parallelizable: false, sleepMs: 20, sideEffect: true },
    { name: 'write_b', parallelizable: false, sleepMs: 20, sideEffect: true },
    { name: 'write_c', parallelizable: false, sleepMs: 20, sideEffect: true },
  ]);
  const { runToolCalls } = await import('./tool-runner.js');

  const start = Date.now();
  const result = await runToolCalls({
    toolCalls: [tc('a', 'write_a'), tc('b', 'write_b'), tc('c', 'write_c')],
    turn: 1,
    tools: registry,
    config: buildConfig(),
    signal: undefined,
    policy: buildPolicy(),
    emitEvent: mockEmitEvent as any,
    onSessionError: () => {},
  });
  const elapsed = Date.now() - start;

  assert.equal(result.toolResults.length, 3);
  // Sequential: each mutating tool flushes its own singleton batch → ≥ 60ms total
  assert.ok(elapsed >= 50, `Expected sequential exec ≥50ms, got ${elapsed}ms`);

  // Execution order must match input order
  assert.equal(registry.executionOrder[0], 'write_a');
  assert.equal(registry.executionOrder[1], 'write_b');
  assert.equal(registry.executionOrder[2], 'write_c');
});

test('denied tool returns error in result but preserves ordering', async () => {
  // Build a custom registry that denies read_file
  const base = mockRegistry([
    { name: 'read_file', parallelizable: true, sleepMs: 10 },
    { name: 'search_content', parallelizable: true, sleepMs: 10 },
  ]);
  const denyRegistry: ToolRegistry & { executionOrder: string[] } = {
    ...base,
    evaluateTool(name: string): ToolExecutionDecision {
      if (name === 'read_file') {
        return { allowed: false, reasonCode: 'tool_risk_exceeded', reason: 'blocked by test', policy: buildPolicy() };
      }
      return base.evaluateTool(name);
    },
  };

  const { runToolCalls } = await import('./tool-runner.js');

  const result = await runToolCalls({
    toolCalls: [tc('r1', 'read_file'), tc('s1', 'search_content')],
    turn: 1,
    tools: denyRegistry,
    config: buildConfig(),
    signal: undefined,
    policy: buildPolicy(),
    emitEvent: mockEmitEvent as any,
    onSessionError: () => {},
  });

  assert.equal(result.toolResults.length, 2);
  // First result is denied — content should be the denial reason
  assert.ok(result.toolResults[0].includes('blocked by test'), `Expected denial msg, got: ${result.toolResults[0]}`);
  assert.ok(result.toolResults[1].includes('result:search_content'));
});
