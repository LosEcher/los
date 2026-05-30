import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  createToolRegistry,
  registerBuiltinTools,
  READ_ONLY_BUILTIN_TOOLS,
} from './registry.js';

test('read-only tool mode excludes write and shell tools', async () => {
  const workspaceRoot = mkdtempSync(join(tmpdir(), 'los-agent-readonly-'));
  try {
    writeFileSync(join(workspaceRoot, 'note.txt'), 'hello', 'utf-8');

    const registry = createToolRegistry({ allowedTools: READ_ONLY_BUILTIN_TOOLS });
    registerBuiltinTools(registry, { workspaceRoot });

    assert.deepEqual(registry.list().sort(), ['list_directory', 'read_file']);

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
    registerBuiltinTools(registryA, { workspaceRoot: workspaceA });

    const registryB = createToolRegistry();
    registerBuiltinTools(registryB, { workspaceRoot: workspaceB });

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
    registerBuiltinTools(registry, { workspaceRoot });

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
