import { getConfig } from '@los/infra/config';

import { runDeclaredChecksForTaskRun, type VerificationCommandRunner } from '../verification-runner.js';
import { normalizeOptionalString } from './helpers.js';
import { createNodeCheckRunner } from './node-check-runner.js';

/**
 * 调度 run 的声明式检查：决定**在哪台机器上执行**，然后执行并留证。
 *
 * - 本地 run（网关进程内 / `gateway-local`）⇒ 本机执行（`commandRunner` 缺省即本机 spawn）。
 * - 远端 run ⇒ 走节点通道在**节点本地**执行（`run-check`）；节点没有该通道时记 skipped 并写明原因，
 *   绝不在网关本地代跑（那会产出"看起来像证据的假证据"）。
 *
 * 判定语义：本函数只负责执行与留证，**不改变** run 终态（改判定属策略决定，见 §第四批文档）。
 */
export async function runScheduledDeclaredChecks(input: {
  sessionId: string;
  taskRunId: string;
  runSpecId?: string;
  checks: string[];
  workspaceRoot?: string;
  nodeId?: string;
}): Promise<{ executed: boolean; skipReason?: string }> {
  if (input.checks.length === 0) return { executed: false };

  const config = getConfig();
  const gatewayNodeId = normalizeOptionalString(config.executor.nodeId);
  const runNodeId = normalizeOptionalString(input.nodeId);
  const isLocalRun = !runNodeId || runNodeId === 'gateway-local' || runNodeId === gatewayNodeId;

  let commandRunner: VerificationCommandRunner | undefined;
  if (!isLocalRun && runNodeId) {
    commandRunner = createNodeCheckRunner({
      nodeId: runNodeId,
      agentKey: normalizeOptionalString(config.executor.agentKey),
    });
  }
  const skipReason = isLocalRun || commandRunner
    ? undefined
    : 'remote_run_required_checks_need_node_execution';

  await runDeclaredChecksForTaskRun({
    sessionId: input.sessionId,
    taskRunId: input.taskRunId,
    runSpecId: input.runSpecId,
    checks: input.checks,
    cwd: normalizeOptionalString(input.workspaceRoot),
    commandRunner,
    skipReason,
  });
  return { executed: !skipReason, ...(skipReason ? { skipReason } : {}) };
}
