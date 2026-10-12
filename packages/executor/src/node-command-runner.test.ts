import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { NodeCommandRuntimeContext } from '@los/agent/node-commands';
import { _normalizeWindowsCwd, _planGovernedCheckSpawn, createExecutorNodeCommandRuntime } from './node-command-runner.js';

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

/**
 * 2026-10-11 实测（S8）：Windows 节点拿不到 agent 派发，报的错误有**两种**，
 * 而根因是同一层。这两条用例就是那两个报错的机械复现。
 */
test('_planGovernedCheckSpawn: win32 走 PowerShell，且不把 POSIX cwd 直接交给 spawn', () => {
  const plan = _planGovernedCheckSpawn({ command: 'if ($true) { 1 }', requestedCwd: '/tmp', platform: 'win32' });
  // ① 壳必须是 PowerShell 本体（不能把 PowerShell 文本丢给 cmd.exe 解析——那是假修）
  assert.match(plan.exe, /powershell\.exe$/i);
  assert.deepEqual(plan.argv.slice(0, 4), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass']);
  assert.equal(plan.argv.at(-1), 'if ($true) { 1 }');
  // ② `/tmp` 在 Windows 上不存在 ⇒ spawn 会以 ENOENT 失败并**报成"找不到 cmd.exe"**。
  //    这条断言守的正是那个误诊：cwd 必须被规范化，且改写要留痕。
  assert.equal(plan.cwd, 'C:/Windows/Temp');
  assert.match(String(plan.note), /\/tmp/);
});

test('_planGovernedCheckSpawn: POSIX 分支一个字节都不改（避免 node34/mbp/m3pro 回归）', () => {
  for (const platform of ['darwin', 'linux']) {
    const plan = _planGovernedCheckSpawn({ command: 'uname -s', requestedCwd: '/opt/los', platform });
    assert.equal(plan.exe, 'uname -s', 'POSIX 仍是"整条命令交给 shell"');
    assert.deepEqual(plan.argv, []);
    assert.equal(plan.cwd, '/opt/los');
    assert.equal(plan.note, undefined);
  }
});

test('_normalizeWindowsCwd: 只改写"确定不存在"的路径，别的原样交给 spawn 判', () => {
  // `/tmp` → C:\Windows\Temp：实测该目录在两台 Windows 上都存在（PowerShell 与 cmd 都能跑）
  assert.equal(_normalizeWindowsCwd('/tmp').cwd, 'C:/Windows/Temp');
  // 反斜杠与尾斜杠都要能归一
  assert.equal(_normalizeWindowsCwd('C:\\los-workspace\\portable\\').cwd, 'C:/los-workspace/portable');
  // 其它 POSIX 绝对路径**不猜**：Windows 上 `/opt/x` 可能指 `C:\opt\x`，交给 spawn 如实失败
  assert.equal(_normalizeWindowsCwd('/opt/los').cwd, '/opt/los');
  // 引擎不负责"这个目录存不存在"这件事——那是 spawn 的判据
  assert.equal(_normalizeWindowsCwd('/opt/los').note, undefined);
});

