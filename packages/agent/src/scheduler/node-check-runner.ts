import { loadExecutorNode } from '../executor-nodes.js';
import type { VerificationCommandResult, VerificationCommandRunner } from '../verification-runner.js';
import { normalizeOptionalString, readObject } from './helpers.js';

/**
 * 把声明式检查送到**节点本地**执行（2026-10-11）。
 *
 * 为什么必须有它：远端 run 的工作区是节点本地的（如 `/opt/los/los-workspace`），
 * 在网关本地跑 `uname -s` 会得到 Darwin 而真实检查对象在 Linux 节点上——那等于假证据。
 * 通道复用既有的受治理节点命令（`/v1/nodes/:id/commands` 的 `run-check`），
 * 与派发 agent run 用的是同一个 agent key 授权。
 */
export function createNodeCheckRunner(input: {
  nodeId: string;
  agentKey?: string;
  defaultTimeoutMs?: number;
  /** 调用方已解析好的节点命令端点（也可供测试注入，避免依赖真实节点注册表）。 */
  commandUrl?: string;
}): VerificationCommandRunner {
  return async (command, options): Promise<VerificationCommandResult> => {
    const started = Date.now();
    const base: Omit<VerificationCommandResult, 'exitCode' | 'outputSummary'> = {
      command,
      cwd: options.cwd,
      signal: null,
      durationMs: 0,
    };
    const commandUrl = input.commandUrl ?? await resolveCommandUrl(input.nodeId);
    if (!commandUrl) {
      return {
        ...base,
        durationMs: Date.now() - started,
        exitCode: null,
        outputSummary: '',
        error: `node ${input.nodeId} exposes no governed command endpoint (agent_http.commandUrl)`,
      };
    }

    try {
      const response = await fetch(commandUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(input.agentKey ? { Authorization: `Bearer ${input.agentKey}` } : {}),
        },
        body: JSON.stringify({
          command: 'run-check',
          args: {
            command,
            cwd: options.cwd,
            timeoutMs: options.timeoutMs ?? input.defaultTimeoutMs,
          },
        }),
      });
      const text = await response.text();
      const payload = text ? readObject(JSON.parse(text)) : {};
      const record = readObject(payload.command) ?? {};
      const output = readObject(record.output) ?? {};
      const exitCode = typeof output.exitCode === 'number' ? output.exitCode : null;
      const summary = [output.stdout, output.stderr]
        .map(value => (typeof value === 'string' ? value.trim() : ''))
        .filter(Boolean)
        .join('\n');
      const nodeError = normalizeOptionalString(record.error);
      return {
        ...base,
        durationMs: Date.now() - started,
        exitCode,
        outputSummary: summary.slice(0, 4_000),
        error: nodeError
          ?? (response.ok ? undefined : `node command failed: ${response.status} ${text.slice(0, 200)}`),
      };
    } catch (error) {
      return {
        ...base,
        durationMs: Date.now() - started,
        exitCode: null,
        outputSummary: '',
        error: error instanceof Error ? error.message : String(error),
      };
    }
  };
}

async function resolveCommandUrl(nodeId: string): Promise<string | undefined> {
  const node = await loadExecutorNode(nodeId).catch(() => null);
  return normalizeOptionalString(readObject(readObject(node?.connectConfig)?.agent_http)?.commandUrl);
}
