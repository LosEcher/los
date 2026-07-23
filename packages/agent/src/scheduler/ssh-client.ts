/**
 * @los/agent/scheduler/ssh-client — Execute agent tasks on remote nodes via SSH.
 *
 * Opens an SSH connection via node:child_process spawn (ssh CLI), streams
 * the executor's ndjson output back, and returns the parsed AgentResult.
 *
 * SSH connect modes:
 *   - direct_ssh: raw TCP SSH (ssh user@host)
 *   - tailscale_ssh: through Tailscale (ssh user@ts-host)
 *   - cf_tunnel_ssh: through Cloudflare Tunnel (ssh user@cf-host)
 *
 * All three use the same underlying ssh binary with different host/key config.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { getLogger } from '@los/infra/logger';
import type { AgentResult, AgentConfig, ToolCallStateTransition } from '../loop.js';
import type { KernelEvent } from '../execution-kernel.js';
import type { ExecutorNodeRecord } from '../executor-nodes.js';

const log = getLogger('ssh-client');

export interface SSHClientConfig {
  /** SSH username (required). */
  user: string;
  /** Hostname or IP (required). */
  host: string;
  /** SSH port (default 22). */
  port?: number;
  /** Path to private key file (default ~/.ssh/id_rsa). */
  identityFile?: string;
  /** Additional SSH options (e.g., StrictHostKeyChecking). */
  options?: string[];
  /** SSH connection timeout in seconds. */
  connectTimeoutSec?: number;
  /** los executor binary path on remote (default "los-executor"). */
  executorBin?: string;
  /** los executor port on remote (default 8090). */
  executorPort?: number;
}

export function readSSHConfig(connectConfig: Record<string, unknown>): SSHClientConfig | null {
  const config = (connectConfig.direct_ssh ??
    connectConfig.tailscale_ssh ??
    connectConfig.cf_tunnel_ssh ??
    connectConfig.tailscale_native_ssh) as Record<string, unknown> | undefined;

  if (!config) return null;

  const user = typeof config.user === 'string' ? config.user : null;
  const host = typeof config.host === 'string' ? config.host : null;
  if (!user || !host) {
    log.warn('SSH config missing user or host', { config });
    return null;
  }

  return {
    user,
    host,
    port: typeof config.port === 'number' ? config.port : undefined,
    identityFile: typeof config.identityFile === 'string' ? config.identityFile : undefined,
    options: Array.isArray(config.options) ? config.options.filter((o): o is string => typeof o === 'string') : undefined,
    connectTimeoutSec: typeof config.connectTimeoutSec === 'number' ? config.connectTimeoutSec : undefined,
    executorBin: typeof config.executorBin === 'string' ? config.executorBin : undefined,
    executorPort: typeof config.executorPort === 'number' ? config.executorPort : undefined,
  };
}

export function resolveSSHExecutorNodeUrl(node: ExecutorNodeRecord): string | null {
  const sshConfig = readSSHConfig(node.connectConfig);
  if (!sshConfig) return null;
  const {
    user, host, port = 22, identityFile,
    executorBin = 'los-executor', executorPort = 8090,
  } = sshConfig;
  const url = new URL(`ssh://${encodeURIComponent(user)}@${host}`);
  if (port !== 22) url.port = String(port);
  if (identityFile) url.searchParams.set('identityFile', identityFile);
  url.searchParams.set('bin', executorBin);
  url.searchParams.set('port', String(executorPort));
  return url.toString();
}

/**
 * Parse the los SSH executor URL back into registry-shaped connectConfig.
 * Format: ssh://user@host:22?identityFile=/path/key&bin=los-executor&port=8090
 */
export function sshExecutorUrlToConnectConfig(sshUrl: string): Record<string, unknown> {
  try {
    const url = new URL(sshUrl);
    if (url.protocol !== 'ssh:') return {};
    const user = decodeURIComponent(url.username);
    const host = url.hostname;
    if (!user || !host) return {};
    const port = url.port ? Number(url.port) : 22;
    const executorPort = Number(url.searchParams.get('port') ?? '8090');
    return {
      direct_ssh: {
        user,
        host,
        port: Number.isFinite(port) ? port : 22,
        ...(url.searchParams.has('identityFile') ? { identityFile: url.searchParams.get('identityFile') ?? '' } : {}),
        executorBin: url.searchParams.get('bin') ?? 'los-executor',
        executorPort: Number.isFinite(executorPort) ? executorPort : 8090,
      },
    };
  } catch {
    return {};
  }
}

export interface SSHExecutor {
  url: string;
  nodeId: string;
  agentKey?: string;
  decision: {
    source: 'ssh_registry';
    candidateIds: string[];
    selectedId: string;
    skipped: Array<{ id: string; reason: string }>;
  };
  /** Parsed SSH config for command building. */
  sshConfig: SSHClientConfig;
}

/**
 * Resolve SSH executor nodes from the registry.
 * Filters to nodes whose connectConfig contains SSH keys and whose
 * nodeKind or connectModes indicate SSH capability.
 */
export function resolveSSHExecutor(
  node: ExecutorNodeRecord,
): SSHExecutor | null {
  const sshConfig = readSSHConfig(node.connectConfig);
  if (!sshConfig) return null;

  // Node must be reachable via SSH.
  const hasSSHMode = node.connectModes.some(m =>
    m.startsWith('direct_ssh') ||
    m.startsWith('tailscale_ssh') ||
    m.startsWith('tailscale_native_ssh') ||
    m.startsWith('cf_tunnel_ssh'),
  );
  if (!hasSSHMode && node.nodeKind !== 'ssh_target') return null;

  const url = resolveSSHExecutorNodeUrl(node);
  if (!url) return null;

  return {
    url,
    nodeId: node.nodeId,
    decision: {
      source: 'ssh_registry',
      candidateIds: [node.nodeId],
      selectedId: node.nodeId,
      skipped: [],
    },
    sshConfig,
  };
}

function buildSSHArgs(config: SSHClientConfig): string[] {
  const {
    user, host, port = 22, identityFile,
    options = [], connectTimeoutSec = 30,
  } = config;

  const args: string[] = [];
  if (identityFile) args.push('-i', identityFile);
  args.push('-p', String(port));
  if (connectTimeoutSec > 0) args.push('-o', `ConnectTimeout=${connectTimeoutSec}`);
  args.push('-o', 'StrictHostKeyChecking=accept-new');
  args.push('-o', 'ServerAliveInterval=15');
  for (const opt of options) args.push('-o', opt);
  args.push(`${user}@${host}`);
  return args;
}

/**
 * Run a command on a remote executor via SSH and stream ndjson results back.
 *
 * The SSH command runs the los executor CLI on the remote node, which
 * accepts the same /v1/tasks/run-agent payload over stdin and streams
 * ndjson chunks to stdout.
 */
function runSSHCommand(
  sshConfig: SSHClientConfig,
  input: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<{ stdout: AsyncIterable<string>; process: ChildProcess }> {
  const { executorBin = 'los-executor', executorPort = 8090 } = sshConfig;
  const sshArgs = buildSSHArgs(sshConfig);

  // On the remote, we run the executor's run-agent CLI command.
  // This keeps SSH invocation simple — one command, ndjson to stdout.
  const remoteCmd = `${executorBin} run-agent \
--port ${executorPort} \
--stdin`;

  sshArgs.push('--', remoteCmd);

  const proc = spawn('ssh', sshArgs, {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, LC_ALL: 'C.UTF-8' },
  });

  // Feed the run-agent input as JSON on stdin.
  const stdinData = JSON.stringify(input);
  proc.stdin!.end(stdinData + '\n');

  if (signal) {
    const onAbort = () => { proc.kill('SIGTERM'); };
    signal.addEventListener('abort', onAbort, { once: true });
    proc.on('close', () => signal.removeEventListener('abort', onAbort));
  }

  return Promise.resolve({
    stdout: createLineIterator(proc),
    process: proc,
  });
}

async function* createLineIterator(proc: ChildProcess): AsyncIterable<string> {
  const decoder = new TextDecoder();
  let buffer = '';

  for await (const chunk of proc.stdout! as AsyncIterable<Buffer>) {
    buffer += decoder.decode(chunk, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (line.trim()) yield line;
    }
  }
  if (buffer.trim()) yield buffer;
}

export async function runAgentOnSSHExecutor(
  sshExecutor: SSHExecutor,
  input: {
    taskRunId: string;
    leaseMs: number;
    executionKernelKind: string;
    prompt: string;
    config: Omit<AgentConfig, 'signal' | 'onSessionEvent' | 'onTurn' | 'onToolCall' | 'onCheckpoint'>;
    signal?: AbortSignal;
    onSessionEvent?: AgentConfig['onSessionEvent'];
    onModelDelta?: AgentConfig['onModelDelta'];
    onToolCallState?: AgentConfig['onToolCallState'];
    onCheckpoint?: AgentConfig['onCheckpoint'];
    onKernelEvent?: (event: KernelEvent) => void | Promise<void>;
  },
): Promise<AgentResult> {
  const payload = {
    taskRunId: input.taskRunId,
    nodeId: sshExecutor.nodeId,
    leaseMs: input.leaseMs,
    executionKernelKind: input.executionKernelKind,
    prompt: input.prompt,
    config: input.config,
  };

  const { stdout } = await runSSHCommand(sshExecutor.sshConfig, payload, input.signal);

  let result: AgentResult | null = null;

  for await (const line of stdout) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let chunk: {
      type?: string;
      event?: unknown;
      delta?: unknown;
      transition?: unknown;
      kernelEvent?: unknown;
      result?: unknown;
      error?: string;
    };
    try {
      chunk = JSON.parse(trimmed);
    } catch {
      log.warn(`ssh executor non-JSON line: ${trimmed.slice(0, 120)}`);
      continue;
    }

    if (chunk.type === 'session_event') {
      await input.onSessionEvent?.(chunk.event as any);
    } else if (chunk.type === 'model_delta') {
      await input.onModelDelta?.(chunk.delta as any);
    } else if (chunk.type === 'tool_call_state') {
      await input.onToolCallState?.(chunk.transition as ToolCallStateTransition);
    } else if (chunk.type === 'kernel_event') {
      await input.onKernelEvent?.(chunk.kernelEvent as KernelEvent);
    } else if (chunk.type === 'result') {
      result = chunk.result as AgentResult;
    } else if (chunk.type === 'error') {
      throw new Error(chunk.error ?? 'SSH executor stream error');
    }
  }

  if (!result) throw new Error(`SSH executor ${sshExecutor.nodeId} stream completed without result`);
  return result;
}
