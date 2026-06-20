// SSH command runner: execute commands on remote nodes via SSH.
// Used by the gateway to dispatch commands to ssh_target / tailscale_ssh nodes
// that don't have the executor binary deployed.
import { spawn } from 'node:child_process';
import { getLogger } from '@los/infra/logger';
import type { ExecutorNodeRecord } from '@los/agent/executor-nodes';

const log = getLogger('gateway');

export interface SshRunOptions {
  /** Command to run on the remote host (passed to bash -lc). */
  command: string;
  /** Timeout in milliseconds. Default 30_000. */
  timeoutMs?: number;
  /** Working directory on the remote host. Defaults to home dir. */
  cwd?: string;
  /** Environment variables to set on the remote host. */
  env?: Record<string, string>;
}

export interface SshRunResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  /** Signal name if killed by a signal. */
  signal: string | null;
  /** Whether the SSH connection itself succeeded. */
  connected: boolean;
  /** Human-readable error from the transport layer. */
  error?: string;
}

/**
 * Execute a command on a remote node via SSH using the node's connectConfig.
 *
 * Reads:
 *   connectConfig.ssh.host_name (required)
 *   connectConfig.ssh.user        (optional)
 *   connectConfig.ssh.port        (optional, default 22)
 *   connectConfig.ssh.identity_file (optional)
 */
export async function runSshCommand(
  node: Pick<ExecutorNodeRecord, 'nodeId' | 'connectConfig'>,
  opts: SshRunOptions,
): Promise<SshRunResult> {
  const ssh = (node.connectConfig?.ssh ?? {}) as Record<string, unknown>;
  const host = String(ssh.host_name ?? '');
  if (!host) {
    return {
      stdout: '',
      stderr: '',
      exitCode: null,
      signal: null,
      connected: false,
      error: `node ${node.nodeId}: missing connectConfig.ssh.host_name`,
    };
  }

  const user = typeof ssh.user === 'string' && ssh.user ? ssh.user : undefined;
  const port = typeof ssh.port === 'number' && ssh.port > 0 ? ssh.port : 22;
  const identityFile = typeof ssh.identity_file === 'string' && ssh.identity_file ? ssh.identity_file : undefined;

  const args = buildSshArgs({ host, user, port, identityFile, command: opts });
  const timeoutMs = opts.timeoutMs ?? 30_000;

  return new Promise((resolve) => {
    const child = spawn('ssh', args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: timeoutMs,
    });

    let stdout = '';
    let stderr = '';

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf-8');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf-8');
    });

    child.on('error', (err: NodeJS.ErrnoException) => {
      resolve({
        stdout: stdout.trimEnd(),
        stderr: stderr.trimEnd(),
        exitCode: null,
        signal: null,
        connected: false,
        error: err.code === 'ENOENT' ? 'ssh binary not found' : err.message,
      });
    });

    child.on('close', (code, signal) => {
      // SSH exits with the remote command's exit code (255 = SSH transport error)
      const connected = code !== 255 && signal !== 'SIGKILL';
      if (!connected && code === 255) {
        log.warn(`SSH transport error to ${host}:${port} (node ${node.nodeId})`);
      }
      resolve({
        stdout: stdout.trimEnd(),
        stderr: stderr.trimEnd(),
        exitCode: code,
        signal,
        connected,
      });
    });
  });
}

function buildSshArgs(params: {
  host: string;
  user?: string;
  port: number;
  identityFile?: string;
  command: SshRunOptions;
}): string[] {
  const args: string[] = [
    '-o', 'BatchMode=yes',
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', `ConnectTimeout=${Math.max(1, Math.floor((params.command.timeoutMs ?? 30_000) / 5000))}`,
    '-p', String(params.port),
  ];

  if (params.identityFile) {
    args.push('-i', params.identityFile);
  }

  const target = params.user ? `${params.user}@${params.host}` : params.host;
  args.push(target);

  // Build the remote command line
  const parts: string[] = [];
  if (params.command.cwd) {
    parts.push(`cd ${shellQuote(params.command.cwd)}`);
  }
  if (params.command.env) {
    for (const [k, v] of Object.entries(params.command.env)) {
      parts.push(`export ${shellQuote(k)}=${shellQuote(v)}`);
    }
  }
  parts.push(params.command.command);
  args.push(parts.join('; '));

  return args;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
