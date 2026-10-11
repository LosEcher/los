import assert from 'node:assert/strict';
import test from 'node:test';

import { loadConfig } from '@los/infra/config';
import { closeDb, initDb } from '@los/infra/db';

import { runDeclaredChecksForTaskRun } from './verification-runner.js';
import { ensureVerificationRecordStore, loadVerificationRecord } from './verification-records.js';

/**
 * 调度路径的声明式检查（2026-10-11）：
 * - 有执行器 ⇒ 真的跑命令并把结果落成 verification_records；
 * - 给 skipReason ⇒ 只留证、**绝不执行**（远端 run 的检查必须在节点上跑，不能在网关本地代跑）。
 */
test('declared checks: executes with a runner and records the real result', async () => {
  const config = await loadConfig();
  await initDb(config.databaseUrl);
  try {
    await ensureVerificationRecordStore();
    const stamp = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const calls: string[] = [];
    const records = await runDeclaredChecksForTaskRun({
      sessionId: `session-declared-${stamp}`,
      taskRunId: `task-declared-${stamp}`,
      checks: ['uname -s', 'exit 3'],
      cwd: '/tmp',
      commandRunner: async (command, options) => {
        calls.push(command);
        const ok = command === 'uname -s';
        return {
          command,
          cwd: options.cwd,
          exitCode: ok ? 0 : 3,
          signal: null,
          durationMs: 1,
          outputSummary: ok ? 'Darwin' : 'boom',
          error: ok ? undefined : 'exit 3',
        };
      },
    });

    assert.deepEqual(calls, ['uname -s', 'exit 3']);
    assert.equal(records.length, 2);
    assert.equal(records[0]?.status, 'succeeded');
    assert.equal(records[0]?.outputSummary, 'Darwin');
    assert.equal(records[0]?.taskRunId, `task-declared-${stamp}`);
    assert.equal(records[1]?.status, 'failed');
    assert.equal(records[1]?.error, 'exit 3');
  } finally {
    await closeDb().catch(() => undefined);
  }
});

test('declared checks: a skipReason records evidence and never executes', async () => {
  const config = await loadConfig();
  await initDb(config.databaseUrl);
  try {
    await ensureVerificationRecordStore();
    const stamp = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    let executed = false;
    const records = await runDeclaredChecksForTaskRun({
      sessionId: `session-skipped-${stamp}`,
      taskRunId: `task-skipped-${stamp}`,
      checks: ['uname -s'],
      cwd: '/opt/los/los-workspace',
      skipReason: 'remote_run_required_checks_need_node_execution',
      commandRunner: async (command, options) => {
        executed = true;
        return {
          command,
          cwd: options.cwd,
          exitCode: 0,
          signal: null,
          durationMs: 1,
          outputSummary: 'should not happen',
        };
      },
    });

    assert.equal(executed, false, 'a node-local check must not execute on the gateway host');
    assert.equal(records.length, 1);
    assert.equal(records[0]?.status, 'skipped');
    assert.equal(records[0]?.skipReason, 'remote_run_required_checks_need_node_execution');
    assert.equal(records[0]?.outputSummary, undefined);

    const reloaded = await loadVerificationRecord(`verification-task-skipped-${stamp}-check-1`);
    assert.equal(reloaded?.status, 'skipped');
  } finally {
    await closeDb().catch(() => undefined);
  }
});
