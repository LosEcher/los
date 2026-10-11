import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { NodeCommandRuntimeContext } from '@los/agent/node-commands';
import { createExecutorNodeCommandRuntime } from './node-command-runner.js';

test('executor node command runtime refuses maintenance without helper script', async () => {
  const originalCwd = process.cwd();
  const tempRoot = mkdtempSync(join(tmpdir(), 'los-executor-runtime-'));

  try {
    process.chdir(tempRoot);
    const moduleUrl = new URL(`./node-command-runner.ts?missing-helper=${Date.now()}`, import.meta.url).href;
    const { createExecutorNodeCommandRuntime } = await import(moduleUrl);
    const runtime = createExecutorNodeCommandRuntime();

    await assert.rejects(
      () => runtime.restart?.({
        commandId: 'node-command-test',
        input: { nodeId: 'node-test', command: 'restart' },
        node: {},
      } as NodeCommandRuntimeContext),
      /executor helper not found: .*tools\/executor\.sh/,
    );
  } finally {
    process.chdir(originalCwd);
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('run-check executes on the node and reports exit code plus output', async () => {
  const runtime = createExecutorNodeCommandRuntime();
  const run = (args: Record<string, unknown>) =>
    runtime['run-check']?.({
      commandId: 'node-command-check',
      input: { nodeId: 'node-test', command: 'run-check', args },
      node: {},
    } as NodeCommandRuntimeContext);

  const ok = await run({ command: 'echo node34-check-ok', cwd: '/tmp' });
  assert.equal(ok?.status, 'succeeded');
  assert.equal((ok?.output as Record<string, unknown>).stdout, 'node34-check-ok');
  assert.equal((ok?.output as Record<string, unknown>).exitCode, 0);

  const failed = await run({ command: 'exit 7', cwd: '/tmp' });
  assert.equal(failed?.status, 'failed');
  assert.equal((failed?.output as Record<string, unknown>).exitCode, 7);
  assert.match(String(failed?.error), /exit 7/);

  // 没有命令 ⇒ 明确失败，不得静默成功
  const missing = await run({});
  assert.equal(missing?.status, 'failed');
  assert.match(String(missing?.error), /requires args.command/);
});

