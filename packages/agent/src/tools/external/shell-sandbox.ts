import { execFile } from 'node:child_process';
import { accessSync, constants, realpathSync } from 'node:fs';
import { platform } from 'node:os';
import { getLogger } from '@los/infra/logger';

const log = getLogger('agent');

// ── Environment minimization ─────────────────────────────
//
// Three backends inherit process.env via execFile by default. To minimize
// credential leakage we (1) pass only an allowlist of safe variables,
// (2) substitute sensitive variables with a sentinel value so programs see a
// stable placeholder instead of a real credential, and (3) redact real
// sensitive values from command output.

/** Sentinel substituted for sensitive environment values. */
export const ENV_REDACTED_SENTINEL = '__LOS_REDACTED__';

/** Variables that are always safe to pass to a sandboxed shell. */
export const SANDBOX_ENV_ALLOWLIST = ['PATH', 'HOME', 'LANG', 'LC_ALL'];

/** Key prefixes that mark an environment variable as sensitive (never passed verbatim). */
export const SENSITIVE_ENV_PREFIXES = [
  'TOKEN', 'TOK_', 'SECRET', 'PASSWORD', 'PASSWD', 'PASS_',
  'API_KEY', 'APIKEY', 'CREDENTIAL', 'AUTH', 'PRIVATE_KEY', 'PRIVATE_',
  'AWS_ACCESS', 'AWS_SECRET', 'AZURE_', 'GCP_', 'OPENAI_API', 'ANTHROPIC_API',
];

function isSensitiveEnvKey(key: string): boolean {
  const upper = key.toUpperCase();
  return SENSITIVE_ENV_PREFIXES.some(p => upper.startsWith(p) || upper.includes(p.toUpperCase()));
}

function isAllowedEnvKey(key: string): boolean {
  if (SANDBOX_ENV_ALLOWLIST.includes(key)) return true;
  return key.startsWith('LC_');
}

/**
 * Build the minimal environment for a sandboxed shell:
 * - allowlisted safe variables pass through verbatim;
 * - every other variable is dropped, except sensitive ones which are passed
 *   with a sentinel value so tooling sees a stable placeholder, never a secret.
 */
export function buildSandboxEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (!key) continue;
    if (isAllowedEnvKey(key)) {
      result[key] = value;
    } else if (isSensitiveEnvKey(key)) {
      result[key] = ENV_REDACTED_SENTINEL;
    }
    // non-allowed, non-sensitive variables are dropped entirely
  }
  return result;
}

/**
 * Redact real sensitive environment values from command output.
 * Guards against a command echoing an inherited credential back into the
 * transcript even when the env itself is minimized (defense in depth).
 */
export function redactSensitiveOutput(text: string, env: NodeJS.ProcessEnv = process.env): string {
  let out = text;
  for (const [key, value] of Object.entries(env)) {
    if (!key || !value || value.length < 4) continue;
    if (!isSensitiveEnvKey(key)) continue;
    if (out.includes(value)) {
      out = out.split(value).join(ENV_REDACTED_SENTINEL);
    }
  }
  return out;
}

export interface SandboxedShellInput {
  command: string;
  cwd: string;
  timeoutMs: number;
}

/** Sandbox isolation level. Maps to config agent.sandboxMode. */
export type SandboxMode = 'readonly' | 'workspace-write' | 'sandbox';

export interface SandboxedShellOptions {
  /** Permit the unconstrained native shell when no OS sandbox backend is
   *  available. Defaults to false: execution is denied instead (Claude-style
   *  deny; wired to config agent.allowNativeShell). */
  allowNativeShell?: boolean;
  /** Filesystem/network isolation level. Defaults to 'workspace-write':
   *  read-only root, writes confined to the workspace cwd (current
   *  behavior). 'readonly' denies writes entirely; 'sandbox' keeps the OS
   *  sandbox with workspace writes (alias for the strictest enforced
   *  profile). Wired to config agent.sandboxMode. */
  sandboxMode?: SandboxMode;
  /** Network isolation inside the OS sandbox. Defaults to 'isolated' —
   *  fail-closed: bwrap runs with --unshare-net and sandbox-exec denies
   *  network entirely. 'host' drops the network isolation so read-only
   *  diagnostics (ping/curl/probes) reach real endpoints; it weakens the
   *  sandbox and must only be enabled for trusted read-only workloads.
   *  Wired to config agent.sandboxNetwork. */
  networkMode?: 'isolated' | 'host';
}

export interface SandboxedShellResult {
  content: string;
  error?: string;
  sandbox: string;
}

/** Decision of which backend runs a shell command (or whether it is denied). */
export type SandboxDecision = 'macos-sandbox-exec' | 'linux-bwrap' | 'native' | 'native-denied';

/**
 * Pure backend-selection decision, separated from execFile side effects so
 * tests can cover every platform/availability/allow combination.
 */
export function resolveSandboxBackend(
  osPlatform: string,
  sandboxExecAvailable: boolean,
  bwrapAvailable: boolean,
  allowNativeShell: boolean,
): SandboxDecision {
  if (osPlatform === 'darwin') {
    if (sandboxExecAvailable) return 'macos-sandbox-exec';
    return allowNativeShell ? 'native' : 'native-denied';
  }
  if (osPlatform === 'linux') {
    if (bwrapAvailable) return 'linux-bwrap';
    return allowNativeShell ? 'native' : 'native-denied';
  }
  return allowNativeShell ? 'native' : 'native-denied';
}

/**
 * Check which sandbox backend is available on this system.
 * Returns the sandbox name, or 'native' if no sandbox is available.
 */
export function getAvailableSandbox(): string {
  if (platform() === 'darwin' && findExecutable('/usr/bin/sandbox-exec')) {
    return 'macos-sandbox-exec';
  }
  if (platform() === 'linux' && findExecutable('/usr/bin/bwrap')) {
    return 'linux-bwrap';
  }
  return 'native';
}

export async function runSandboxedShell(
  input: SandboxedShellInput,
  options: SandboxedShellOptions = {},
): Promise<SandboxedShellResult> {
  const allowNative = options.allowNativeShell === true;
  const sandboxMode = options.sandboxMode ?? 'workspace-write';
  const networkMode = options.networkMode ?? 'isolated';
  const decision = resolveSandboxBackend(
    platform(),
    findExecutable('/usr/bin/sandbox-exec') !== null,
    findExecutable('/usr/bin/bwrap') !== null,
    allowNative,
  );

  switch (decision) {
    case 'macos-sandbox-exec':
      return runWithMacSandboxExec('/usr/bin/sandbox-exec', input, sandboxMode, networkMode);
    case 'linux-bwrap':
      return runWithBwrap('/usr/bin/bwrap', input, sandboxMode, networkMode);
    case 'native':
      log.warn('no OS sandbox backend available; allowNativeShell=true — running unconstrained native shell');
      return runWithNativeShell(input);
    case 'native-denied': {
      log.warn('no OS sandbox backend available and allowNativeShell=false; denying shell execution');
      return {
        content: '',
        error: 'shell execution denied: no sandbox backend available and native fallback is disabled (set AGENT_ALLOW_NATIVE_SHELL=true / agent.allowNativeShell to allow unconstrained execution)',
        sandbox: 'native-denied',
      };
    }
  }
}

// ── macOS sandbox-exec ──────────────────────────────────

/**
 * Build the macOS sandbox-exec profile for a workspace cwd.
 *
 * Profile differences by sandboxMode (default behavior for
 * 'workspace-write'/'sandbox' is unchanged):
 * - 'readonly':       no write permission at all (read-only root + cwd)
 * - 'workspace-write': reads anywhere, writes confined to cwd (current profile)
 * - 'sandbox':        same enforced profile as workspace-write (OS sandbox is
 *                     the strictest backend we run; network stays denied)
 *
 * networkMode='host' drops the `(deny network*)` clause so commands can reach
 * real endpoints (read-only diagnostics); default 'isolated' keeps it.
 */
export function _buildMacSandboxProfile(cwd: string, sandboxMode: SandboxMode = 'workspace-write', networkMode: 'isolated' | 'host' = 'isolated'): string {
  const writeClause = sandboxMode === 'readonly'
    ? []
    : [`(allow file-write* (subpath "${escapeSandboxString(cwd)}"))`];
  const networkClause = networkMode === 'host'
    ? []
    : ['(deny network*)'];
  return [
    '(version 1)',
    '(deny default)',
    '(allow process*)',
    '(allow sysctl-read)',
    '(allow file-read*)',
    ...writeClause,
    ...networkClause,
  ].join('\n');
}

/**
 * Build bubblewrap args for a workspace cwd.
 *
 * - 'readonly':        cwd mounted read-only (--ro-bind)
 * - 'workspace-write': cwd mounted writable (--bind, current behavior)
 * - 'sandbox':         same as workspace-write
 *
 * networkMode='host' drops `--unshare-net` (host network namespace) for
 * read-only diagnostics; default 'isolated' keeps network isolation.
 */
export function _buildBwrapArgs(
  bwrapPath: string,
  cwd: string,
  command: string,
  sandboxMode: SandboxMode = 'workspace-write',
  networkMode: 'isolated' | 'host' = 'isolated',
): string[] {
  const bindFlag = sandboxMode === 'readonly' ? '--ro-bind' : '--bind';
  const netArgs = networkMode === 'host'
    ? []
    : ['--unshare-net'];
  return [
    '--ro-bind', '/', '/',
    bindFlag, cwd, cwd,
    '--chdir', cwd,
    ...netArgs,
    '--die-with-parent',
    '--proc', '/proc',
    '--dev', '/dev',
    '--tmpfs', '/tmp',
    '--', '/bin/bash', '--noprofile', '--norc', '-lc', command,
  ];
}

function runWithMacSandboxExec(
  sandboxExec: string,
  input: SandboxedShellInput,
  sandboxMode: SandboxMode,
  networkMode: 'isolated' | 'host',
): Promise<SandboxedShellResult> {
  const cwd = realpathSync(input.cwd);
  const profile = _buildMacSandboxProfile(cwd, sandboxMode, networkMode);

  return new Promise((resolve) => {
    execFile(
      sandboxExec,
      ['-p', profile, '/bin/bash', '--noprofile', '--norc', '-lc', input.command],
      {
        cwd,
        timeout: input.timeoutMs,
        maxBuffer: 1024 * 1024,
        encoding: 'utf-8',
        env: buildSandboxEnv(),
      },
      (err, stdout, stderr) => {
        const error = err ? redactSensitiveOutput(String(stderr || err.message)) : undefined;
        resolve({
          content: redactSensitiveOutput(String(stdout ?? '')),
          error,
          sandbox: 'macos-sandbox-exec',
        });
      },
    );
  });
}

// ── Linux bubblewrap (bwrap) ─────────────────────────────

function runWithBwrap(
  bwrapPath: string,
  input: SandboxedShellInput,
  sandboxMode: SandboxMode,
  networkMode: 'isolated' | 'host',
): Promise<SandboxedShellResult> {
  const cwd = realpathSync(input.cwd);
  // Create a minimal container: read-only root, writable cwd, no network
  // (unless networkMode='host' for trusted read-only diagnostics)
  const args = _buildBwrapArgs(bwrapPath, cwd, input.command, sandboxMode, networkMode);

  return new Promise((resolve) => {
    execFile(
      bwrapPath,
      args,
      {
        cwd,
        timeout: input.timeoutMs,
        maxBuffer: 1024 * 1024,
        encoding: 'utf-8',
        env: buildSandboxEnv(),
      },
      (err, stdout, stderr) => {
        const error = err ? redactSensitiveOutput(String(stderr || err.message)) : undefined;
        resolve({
          content: redactSensitiveOutput(String(stdout ?? '')),
          error,
          sandbox: 'linux-bwrap',
        });
      },
    );
  });
}

// ── Native fallback (no sandbox) ─────────────────────────

function runWithNativeShell(input: SandboxedShellInput): Promise<SandboxedShellResult> {
  const cwd = input.cwd;
  return new Promise((resolve) => {
    execFile(
      '/bin/bash',
      ['--noprofile', '--norc', '-lc', input.command],
      {
        cwd,
        timeout: input.timeoutMs,
        maxBuffer: 1024 * 1024,
        encoding: 'utf-8',
        env: buildSandboxEnv(),
      },
      (err, stdout, stderr) => {
        // Prepend a sandbox warning so the model knows it's unconstrained
        const warning = '[sandbox: native — no filesystem/network isolation]\n';
        const error = err ? redactSensitiveOutput(String(stderr || err.message)) : undefined;
        resolve({
          content: warning + redactSensitiveOutput(String(stdout ?? '')),
          error,
          sandbox: 'native',
        });
      },
    );
  });
}

// ── Helpers ──────────────────────────────────────────────

function findExecutable(path: string): string | null {
  try {
    accessSync(path, constants.X_OK);
    return path;
  } catch {
    return null;
  }
}

function escapeSandboxString(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}
