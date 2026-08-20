// SSH command runner: execute commands on remote nodes via SSH.
// Used by the gateway to dispatch commands to ssh_target / tailscale_ssh nodes
// that don't have the executor binary deployed.
//
// Execution is dispatched to `unirun ssh` when the binary is available
// (LOS_SSH_RUNNER=auto|unirun|native, default auto): unirun normalizes the
// cross-platform matrix — exact exit-code propagation, in-process deadline
// with whole-tree kill, encoding pipeline (GBK/CLIXML/UTF-16LE), and a stable
// error taxonomy — with the same SshRunResult contract. When unirun is
// missing or the call fails, we fall back to the native ssh implementation so
// the gateway never hard-depends on the binary.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { getLogger } from '@los/infra/logger';
import type { ExecutorNodeRecord } from '@los/agent/executor-nodes';

const log = getLogger('gateway');

export interface SshRunOptions {
  /** Command to run on the remote host (passed to the remote shell). */
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

export type SshRunnerMode = 'auto' | 'unirun' | 'native';

/** Injectable seams for tests (defaults are the real implementations). */
export interface SshRunnerDeps {
  /** Detect whether the unirun binary is available. */
  detectUnirun?: () => Promise<boolean>;
  /** Run `unirun` with args; resolves {code, stdout, stderr}. */
  runUnirun?: (args: string[], timeoutMs: number) => Promise<{ code: number; stdout: string; stderr: string }>;
  /** Native ssh path (defaults to the spawn-based implementation). */
  runNative?: typeof _runSshNative;
}

interface UnirunExecResult {
  exit_code: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  timed_out: boolean;
  aborted: boolean;
  error_class: string | null;
  hint: string | null;
}

/** Process-wide unirun availability cache. */
let unirunDetected: boolean | null = null;
/** Resolved unirun binary path (undefined = not resolved yet, null = absent). */
let unirunBin: string | null | undefined;

/**
 * Resolve the unirun binary. Gateway processes (launchd/systemd/containers)
 * often run with a minimal PATH that lacks ~/.cargo/bin, so we probe known
 * locations in addition to PATH, with LOS_UNIRUN_BIN as an explicit override.
 */
export async function _resolveUnirunBinary(
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | null> {
  if (unirunBin !== undefined) return unirunBin;
  const candidates: string[] = [];
  if (env.LOS_UNIRUN_BIN) candidates.push(env.LOS_UNIRUN_BIN);
  candidates.push('unirun');
  const home = homedir();
  candidates.push(join(home, '.cargo', 'bin', 'unirun'));
  candidates.push('/usr/local/bin/unirun', '/opt/homebrew/bin/unirun');

  for (const candidate of candidates) {
    const ok = candidate === 'unirun'
      ? await tryRunUnirunVersion(candidate)
      : existsSync(candidate) && (await tryRunUnirunVersion(candidate));
    if (ok) {
      unirunBin = candidate;
      return candidate;
    }
  }
  unirunBin = null;
  return null;
}

function tryRunUnirunVersion(bin: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(bin, ['--version'], {
      stdio: 'ignore',
      timeout: 3_000,
    });
    child.on('error', () => resolve(false));
    child.on('close', (code) => resolve(code === 0));
  });
}

export function _resolveSshRunnerMode(env: NodeJS.ProcessEnv = process.env): SshRunnerMode {
  const mode = (env.LOS_SSH_RUNNER ?? 'auto').toLowerCase();
  if (mode === 'unirun') return 'unirun';
  if (mode === 'native') return 'native';
  return 'auto';
}

/**
 * Execute a command on a remote node via SSH using the node's connectConfig.
 *
 * Reads:
 *   connectConfig.ssh.host_name (required)
 *   connectConfig.ssh.user        (optional)
 *   connectConfig.ssh.port        (optional, default 22)
 *   connectConfig.ssh.identity_file (optional)
 *   connectConfig.ssh.shell       (optional; bash|sh|zsh|powershell|pwsh|cmd,
 *                                  default bash — unirun ssh branch)
 */
export async function runSshCommand(
  node: Pick<ExecutorNodeRecord, 'nodeId' | 'connectConfig'>,
  opts: SshRunOptions,
  deps: SshRunnerDeps = {},
): Promise<SshRunResult> {
  const mode = _resolveSshRunnerMode();
  const detect = deps.detectUnirun ?? detectUnirunBinary;
  const available = await detect();

  const preferUnirun =
    mode === 'unirun' || (mode === 'auto' && available);

  // unirun ssh does not support remote cwd/env yet — route those to native.
  const needsNativeOnly = Boolean(opts.cwd) || Object.keys(opts.env ?? {}).length > 0;

  if (preferUnirun && !needsNativeOnly) {
    try {
      return await runSshUnirun(node, opts, deps.runUnirun);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      log.warn(`unirun ssh failed for node ${node.nodeId}, falling back to native ssh: ${msg}`);
    }
  }

  return (deps.runNative ?? _runSshNative)(node, opts);
}

async function detectUnirunBinary(): Promise<boolean> {
  if (unirunDetected !== null) return unirunDetected;
  const bin = await _resolveUnirunBinary();
  if (!bin) {
    unirunDetected = false;
    return false;
  }
  try {
    await runUnirunJson(['--version'], 3_000);
    unirunDetected = true;
  } catch {
    unirunDetected = false;
  }
  return unirunDetected;
}

function inferRemoteShell(node: Pick<ExecutorNodeRecord, 'connectConfig'>): string {
  const raw = (node.connectConfig?.ssh as Record<string, unknown> | undefined)?.shell;
  if (typeof raw === 'string' && raw) {
    const s = raw.toLowerCase();
    if (['bash', 'sh', 'zsh', 'powershell', 'pwsh', 'cmd'].includes(s)) return s;
  }
  return 'bash';
}

/** Exported for tests. */
export function _buildUnirunArgs(
  node: Pick<ExecutorNodeRecord, 'connectConfig'>,
  opts: SshRunOptions,
): string[] {
  const ssh = (node.connectConfig?.ssh ?? {}) as Record<string, unknown>;
  const host = String(ssh.host_name ?? '');
  const args = ['ssh', host, opts.command, '--json', '--shell', inferRemoteShell(node)];
  if (typeof ssh.user === 'string' && ssh.user) {
    args.push('--user', ssh.user);
  }
  if (typeof ssh.port === 'number' && ssh.port > 0) {
    args.push('--port', String(ssh.port));
  }
  if (typeof ssh.identity_file === 'string' && ssh.identity_file) {
    args.push('--identity', ssh.identity_file);
  }
  const timeoutSec = Math.max(1, Math.ceil((opts.timeoutMs ?? 30_000) / 1000));
  args.push('--timeout', String(timeoutSec));
  return args;
}

async function runSshUnirun(
  node: Pick<ExecutorNodeRecord, 'nodeId' | 'connectConfig'>,
  opts: SshRunOptions,
  run?: SshRunnerDeps['runUnirun'],
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

  const args = _buildUnirunArgs(node, opts);
  const runner = run ?? runUnirunJson;
  const { code, stdout, stderr } = await runner(args, opts.timeoutMs ?? 30_000);

  // unirun --json exits 0 whenever unirun itself ran; a non-zero code means
  // a unirun-level error (usage / internal), not a remote result.
  if (code !== 0) {
    throw new Error(`unirun ssh exited ${code}: ${stderr.trim() || stdout.trim()}`);
  }

  let parsed: UnirunExecResult;
  try {
    parsed = JSON.parse(stdout) as UnirunExecResult;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    throw new Error(`unirun ssh returned invalid JSON: ${msg}; stderr: ${stderr.trim()}`);
  }

  return _mapExecResult(parsed, opts);
}

/** Exported for tests. */
export function _mapExecResult(r: UnirunExecResult, _opts: SshRunOptions): SshRunResult {
  const stderr = r.stderr ?? '';
  const exitCode = r.exit_code ?? null;
  const transportError = _sshTransportError(exitCode, stderr);
  return {
    stdout: r.stdout ?? '',
    stderr,
    exitCode,
    signal: r.signal ?? null,
    connected: !transportError,
    ...(transportError ? { error: transportError } : {}),
  };
}

/** Heuristic: does this result indicate the SSH transport itself failed
 * (as opposed to the remote command failing)? Exit 255 is OpenSSH's
 * transport-error code; stderr patterns cover the common connection failures.
 * Exported for tests. */
export function _sshTransportError(exitCode: number | null, stderr: string): string | undefined {
  const s = stderr.trim();
  if (exitCode === 255) return s || 'ssh transport error (exit 255)';
  const patterns = [
    /could not resolve hostname/i,
    /name or service not known/i,
    /connection (refused|timed out|closed|reset)/i,
    /no route to host/i,
    /permission denied/i,
    /host key verification failed/i,
    /operation timed out/i,
    /network is unreachable/i,
  ];
  for (const pattern of patterns) {
    if (pattern.test(s)) return s;
  }
  return undefined;
}

/** Run `unirun <args>` and capture stdout/stderr; rejects on spawn failure. */
function runUnirunJson(
  args: string[],
  timeoutMs: number,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const bin = unirunBin ?? 'unirun';
    const child = spawn(bin, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: Math.max(1_000, timeoutMs + 15_000),
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
      reject(err.code === 'ENOENT' ? new Error('unirun binary not found') : err);
    });
    child.on('close', (code) => {
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}

/**
 * Native fallback: execute a command on a remote node via SSH using the
 * node's connectConfig (the pre-unirun implementation).
 */
export async function _runSshNative(
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
