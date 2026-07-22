import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  createToolRegistry,
  registerBuiltinTools,
  READ_ONLY_BUILTIN_TOOLS,
} from './core/registry.js';
import { createSpawnAgentRunner, registerSpawnAgentTool } from './core/agent-tools.js';

test('read-only tool mode excludes write and shell tools', async () => {
  const workspaceRoot = mkdtempSync(join(tmpdir(), 'los-agent-readonly-'));
  try {
    writeFileSync(join(workspaceRoot, 'note.txt'), 'hello', 'utf-8');

    const registry = createToolRegistry({ allowedTools: READ_ONLY_BUILTIN_TOOLS });
    await registerBuiltinTools(registry, { workspaceRoot });

    assert.deepEqual(
      registry.list().sort(),
      ['directory_tree', 'find_in_code', 'get_file_info', 'get_symbols', 'glob', 'list_directory', 'read_file', 'search_content', 'search_files', 'todo_list'],
    );

    const readResult = await registry.execute({
      name: 'read_file',
      arguments: { path: 'note.txt' },
    });
    assert.equal(readResult.error, undefined);
    assert.equal(readResult.content, 'hello');

    const writeResult = await registry.execute({
      name: 'write_file',
      arguments: { path: 'note.txt', content: 'changed' },
    });
    assert.equal(writeResult.content, '');
    assert.equal(writeResult.error, 'Tool not allowed: write_file');

    const shellResult = await registry.execute({
      name: 'run_shell',
      arguments: { command: 'pwd' },
    });
    assert.equal(shellResult.content, '');
    assert.equal(shellResult.error, 'Tool not allowed: run_shell');

    const todoWriteResult = await registry.execute({
      name: 'todo_create',
      arguments: { title: 'should not write' },
    });
    assert.equal(todoWriteResult.content, '');
    assert.equal(todoWriteResult.error, 'Tool not allowed: todo_create');
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test('tool runtime keeps workspace roots isolated per registry', async () => {
  const root = mkdtempSync(join(tmpdir(), 'los-agent-isolation-'));
  const workspaceA = join(root, 'a');
  const workspaceB = join(root, 'b');
  try {
    mkdirSync(workspaceA, { recursive: true });
    mkdirSync(workspaceB, { recursive: true });
    writeFileSync(join(workspaceA, 'note.txt'), 'alpha', 'utf-8');
    writeFileSync(join(workspaceB, 'note.txt'), 'beta', 'utf-8');

    const registryA = createToolRegistry();
    await registerBuiltinTools(registryA, { workspaceRoot: workspaceA });

    const registryB = createToolRegistry();
    await registerBuiltinTools(registryB, { workspaceRoot: workspaceB });

    const readA = await registryA.execute({
      name: 'read_file',
      arguments: { path: 'note.txt' },
    });
    const readB = await registryB.execute({
      name: 'read_file',
      arguments: { path: 'note.txt' },
    });

    assert.equal(readA.error, undefined);
    assert.equal(readA.content, 'alpha');
    assert.equal(readB.error, undefined);
    assert.equal(readB.content, 'beta');

    const traversal = await registryA.execute({
      name: 'read_file',
      arguments: { path: '../b/note.txt' },
    });
    assert.equal(traversal.content, '');
    assert.match(traversal.error ?? '', /Path traversal denied/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('project-write mode allows writes but still blocks shell execution', async () => {
  const workspaceRoot = mkdtempSync(join(tmpdir(), 'los-agent-project-write-'));
  try {
    const registry = createToolRegistry({
      policy: {
        maxRiskLevel: 'L1',
        allowWrites: true,
        sandboxAvailable: false,
      },
    });
    await registerBuiltinTools(registry, { workspaceRoot });

    const writeResult = await registry.execute({
      name: 'write_file',
      arguments: { path: 'note.txt', content: 'updated' },
    });
    assert.equal(writeResult.error, undefined);
    assert.match(writeResult.content, /Wrote 1 lines/);

    const readResult = await registry.execute({
      name: 'read_file',
      arguments: { path: 'note.txt' },
    });
    assert.equal(readResult.content, 'updated');

    const shellResult = await registry.execute({
      name: 'run_shell',
      arguments: { command: 'pwd' },
    });
    assert.equal(shellResult.content, '');
    assert.match(shellResult.error ?? '', /Tool risk L2 exceeds max L1/);

    const shellDecision = registry.evaluateTool('run_shell');
    assert.equal(shellDecision.allowed, false);
    assert.equal(shellDecision.capability?.riskLevel, 'L2');
    assert.equal(shellDecision.policy.maxRiskLevel, 'L1');
    assert.match(shellDecision.reason, /Tool risk L2 exceeds max L1/);
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test('project-write mode exposes patch tools and applies unique replacements only', async () => {
  const workspaceRoot = mkdtempSync(join(tmpdir(), 'los-agent-patch-'));
  try {
    const filePath = join(workspaceRoot, 'note.txt');
    writeFileSync(filePath, 'alpha\nbeta\ngamma\n', 'utf-8');

    const registry = createToolRegistry({
      policy: {
        maxRiskLevel: 'L1',
        allowWrites: true,
        sandboxAvailable: false,
      },
    });
    await registerBuiltinTools(registry, { workspaceRoot });

    assert.ok(registry.list().includes('preview_patch'));
    assert.ok(registry.list().includes('apply_patch'));
    assert.ok(registry.list().includes('edit_file'));

    const previewResult = await registry.execute({
      name: 'preview_patch',
      arguments: {
        path: 'note.txt',
        search: 'beta',
        replace: 'BETA',
      },
    });
    assert.equal(previewResult.error, undefined);
    assert.match(previewResult.content, /Status: preview/);
    assert.match(previewResult.content, /Match line: 2/);

    const unchanged = readFileSync(filePath, 'utf-8');
    assert.equal(unchanged, 'alpha\nbeta\ngamma\n');

    const applyResult = await registry.execute({
      name: 'apply_patch',
      arguments: {
        path: 'note.txt',
        search: 'beta',
        replace: 'BETA',
      },
    });
    assert.equal(applyResult.error, undefined);
    assert.match(applyResult.content, /Status: applied/);

    const updated = readFileSync(filePath, 'utf-8');
    assert.equal(updated, 'alpha\nBETA\ngamma\n');

    const duplicateResult = await registry.execute({
      name: 'edit_file',
      arguments: {
        path: 'note.txt',
        search: 'a',
        replace: 'A',
      },
    });
    assert.equal(duplicateResult.content, '');
    assert.match(duplicateResult.error ?? '', /search text is not unique/);
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test('all mode executes shell commands through the OS sandbox', { skip: !existsSync('/usr/bin/sandbox-exec') }, async () => {
  const workspaceRoot = mkdtempSync(join(tmpdir(), 'los-agent-shell-sandbox-'));
  const outsidePath = join(tmpdir(), `los-agent-outside-${Date.now()}.txt`);
  try {
    const registry = createToolRegistry({
      policy: {
        maxRiskLevel: 'L2',
        allowWrites: true,
        sandboxAvailable: true,
      },
    });
    await registerBuiltinTools(registry, { workspaceRoot });

    const shellResult = await registry.execute({
      name: 'run_shell',
      arguments: {
        command: `echo ok > inside.txt; echo bad > ${outsidePath}`,
      },
    });

    assert.match(shellResult.error ?? '', /Operation not permitted|Permission denied/);
    assert.equal(readFileSync(join(workspaceRoot, 'inside.txt'), 'utf-8').trim(), 'ok');
    assert.equal(existsSync(outsidePath), false);
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true });
    rmSync(outsidePath, { force: true });
  }
});

test('spawn_agent defaults to read-only and forwards runner inputs', async () => {
  const registry = createToolRegistry();
  let seen: any;

  registerSpawnAgentTool(registry, async (request) => {
    seen = request;
    return { content: JSON.stringify(request) };
  });

  const result = await registry.execute({
    name: 'spawn_agent',
    arguments: {
      prompt: 'inspect the workspace',
      provider: 'deepseek',
      maxLoops: 4,
    },
  });

  assert.equal(result.error, undefined);
  assert.ok(seen);
  assert.equal(seen.prompt, 'inspect the workspace');
  assert.equal(seen.provider, 'deepseek');
  assert.equal(seen.toolMode, undefined);
  assert.equal(seen.maxLoops, 4);
  assert.equal(JSON.parse(result.content).prompt, 'inspect the workspace');
});

test('spawn_agent child inherits parent run contract metadata', async () => {
  let seenPrompt: string | undefined;
  let seenConfig: any;
  const runner = createSpawnAgentRunner({
    sessionId: 'parent-session',
    provider: 'parent-provider',
    model: 'parent-model',
    workspaceRoot: '/tmp/los-parent-workspace',
    runContractMetadata: {
      runContract: {
        mode: 'execution',
        phase: 'executing',
        editableSurfaces: ['packages/agent'],
        requiredChecks: ['pnpm --filter @los/agent test'],
      },
    },
    runAgent: async (prompt, config) => {
      seenPrompt = prompt;
      seenConfig = config;
      return {
        text: 'child ok',
        turns: [],
        loopCount: 1,
        totalTokens: { prompt: 0, completion: 0 },
        messages: [],
      };
    },
  });

  const result = await runner({
    prompt: 'do child work',
    toolMode: 'project-write',
    maxLoops: 99,
  });

  assert.equal(result.error, undefined);
  assert.equal(seenPrompt, 'do child work');
  assert.equal(seenConfig.sessionId.startsWith('parent-session:child:'), true);
  assert.equal(seenConfig.provider, 'parent-provider');
  assert.equal(seenConfig.model, 'parent-model');
  assert.equal(seenConfig.workspaceRoot, '/tmp/los-parent-workspace');
  assert.equal(seenConfig.maxLoops, 12);
  assert.equal(seenConfig.runContractMetadata.runContract.phase, 'executing');
  assert.deepEqual(seenConfig.runContractMetadata.runContract.editableSurfaces, ['packages/agent']);
  assert.deepEqual(seenConfig.runContractMetadata.runContract.requiredChecks, ['pnpm --filter @los/agent test']);
  assert.deepEqual(seenConfig.identity, { name: 'child', level: 'minimal' });
  assert.equal(seenConfig.allowedTools.includes('spawn_agent'), false);
  assert.equal(seenConfig.allowedTools.includes('run_shell'), false);
  assert.equal(JSON.parse(result.content).childSessionId.startsWith('parent-session:child:'), true);

  // Mutation isolation: child clone must not widen the parent object (AP6)
  const parentMeta = {
    runContract: {
      mode: 'execution' as const,
      phase: 'executing' as const,
      editableSurfaces: ['packages/agent'],
      requiredChecks: ['pnpm --filter @los/agent test'],
    },
  };
  let childConfig: any;
  const isolator = createSpawnAgentRunner({
    sessionId: 'parent-session',
    provider: 'parent-provider',
    model: 'parent-model',
    workspaceRoot: '/tmp/los-parent-workspace',
    runContractMetadata: parentMeta,
    runAgent: async (_prompt, config) => {
      childConfig = config;
      return { text: 'ok', turns: [], loopCount: 1, totalTokens: { prompt: 0, completion: 0 }, messages: [] };
    },
  });
  await isolator({ prompt: 'isolation check' });
  assert.notEqual(childConfig.runContractMetadata, parentMeta);
  childConfig.runContractMetadata.runContract.requiredChecks.push('evil');
  childConfig.runContractMetadata.runContract.phase = 'planning';
  assert.deepEqual(parentMeta.runContract.requiredChecks, ['pnpm --filter @los/agent test']);
  assert.equal(parentMeta.runContract.phase, 'executing');
});

test('spawn_agent inherits fallback policy unless the child overrides its route', async () => {
  const seen: any[] = [];
  const providerFallback = {
    mode: 'explicit_ordered' as const,
    targets: [{ provider: 'a', model: 'a-1' }, { provider: 'b', model: 'b-1' }],
    onFailure: ['rate_limit' as const],
    requireCompatibilityEvidence: true,
    maxSwitches: 1,
  };
  const runner = createSpawnAgentRunner({
    provider: 'a',
    model: 'a-1',
    providerFallback,
    runAgent: async (_prompt, config) => {
      seen.push(config);
      return { text: 'ok', turns: [], loopCount: 1, totalTokens: { prompt: 0, completion: 0 }, messages: [] };
    },
  });

  await runner({ prompt: 'inherit' });
  await runner({ prompt: 'override', provider: 'c', model: 'c-1' });

  assert.equal(seen[0].providerFallback, providerFallback);
  assert.equal(seen[1].providerFallback, undefined);
  assert.equal(seen[1].provider, 'c');
  assert.equal(seen[1].model, 'c-1');
});

test('tool capability timeout is enforced during execution', async () => {
  const registry = createToolRegistry();
  registry.register(
    'slow_tool',
    async () => {
      await new Promise(resolve => setTimeout(resolve, 100));
      return { content: 'late' };
    },
    {
      type: 'function',
      function: {
        name: 'slow_tool',
        description: 'Slow test tool',
        parameters: { type: 'object', properties: {} },
      },
    },
    {
      riskLevel: 'L0',
      timeoutMs: 5,
      retryable: true,
      idempotent: true,
    },
  );

  const result = await registry.execute({
    name: 'slow_tool',
    arguments: {},
  });

  assert.equal(result.content, '');
  assert.match(result.error ?? '', /Tool timed out after 5ms: slow_tool/);
});

test('tool retry only applies to retryable and idempotent capabilities', async () => {
  const registry = createToolRegistry({
    policy: {
      retry: {
        maxAttempts: 3,
        baseDelayMs: 0,
        maxDelayMs: 0,
      },
    },
  });
  let attempts = 0;
  registry.register(
    'flaky_read',
    async () => {
      attempts += 1;
      if (attempts < 2) return { content: '', error: 'temporary read failure' };
      return { content: 'ok' };
    },
    {
      type: 'function',
      function: {
        name: 'flaky_read',
        description: 'Flaky test read',
        parameters: { type: 'object', properties: {} },
      },
    },
    {
      riskLevel: 'L0',
      retryable: true,
      idempotent: true,
      timeoutMs: 1_000,
    },
  );

  const result = await registry.execute({
    name: 'flaky_read',
    arguments: {},
  });

  assert.equal(result.content, 'ok');
  assert.equal(result.error, undefined);
  assert.equal(result.attempts, 2);
  assert.equal(result.retried, true);
  assert.deepEqual(result.retryErrors, ['temporary read failure']);
});

test('tool retry stops at max attempts and returns every exhausted failure', async () => {
  const registry = createToolRegistry({
    policy: { retry: { maxAttempts: 3, baseDelayMs: 0, maxDelayMs: 0 } },
  });
  let attempts = 0;
  registry.register(
    'exhausted_read',
    async () => {
      attempts += 1;
      return { content: '', error: `temporary failure ${attempts}` };
    },
    {
      type: 'function',
      function: {
        name: 'exhausted_read',
        description: 'Always failing idempotent read',
        parameters: { type: 'object', properties: {} },
      },
    },
    { riskLevel: 'L0', retryable: true, idempotent: true, timeoutMs: 1_000 },
  );

  const result = await registry.execute({ name: 'exhausted_read', arguments: {} });

  assert.equal(attempts, 3);
  assert.equal(result.error, 'temporary failure 3');
  assert.equal(result.attempts, 3);
  assert.equal(result.retried, true);
  assert.deepEqual(result.retryErrors, [
    'temporary failure 1',
    'temporary failure 2',
    'temporary failure 3',
  ]);
});

test('tool retry does not replay non-idempotent capabilities', async () => {
  const registry = createToolRegistry({
    policy: {
      retry: {
        maxAttempts: 3,
        baseDelayMs: 0,
        maxDelayMs: 0,
      },
    },
  });
  let attempts = 0;
  registry.register(
    'flaky_write',
    async () => {
      attempts += 1;
      return { content: '', error: 'write failed' };
    },
    {
      type: 'function',
      function: {
        name: 'flaky_write',
        description: 'Flaky test write',
        parameters: { type: 'object', properties: {} },
      },
    },
    {
      riskLevel: 'L1',
      retryable: true,
      idempotent: false,
      timeoutMs: 1_000,
    },
  );

  const result = await registry.execute({
    name: 'flaky_write',
    arguments: {},
  });

  assert.equal(attempts, 1);
  assert.equal(result.content, '');
  assert.equal(result.error, 'write failed');
  assert.equal(result.attempts, 1);
  assert.equal(result.retried, false);
  assert.deepEqual(result.retryErrors, ['write failed']);
});
