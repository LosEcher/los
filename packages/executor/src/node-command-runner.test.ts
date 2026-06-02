import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { NodeCommandRuntimeContext } from '@los/agent/node-commands';

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
