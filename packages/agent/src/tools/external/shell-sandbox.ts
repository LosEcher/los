import { execFile } from 'node:child_process';
import { accessSync, constants, realpathSync } from 'node:fs';
import { platform } from 'node:os';
import { getLogger } from '@los/infra/logger';

const log = getLogger('agent');

export interface SandboxedShellInput {
  command: string;
  cwd: string;
  timeoutMs: number;
}

export interface SandboxedShellOptions {
  /** Permit the unconstrained native shell when no OS sandbox backend is
   *  available. Defaults to false: execution is denied instead (Claude-style
   *  deny; wired to config agent.allowNativeShell). */
  allowNativeShell?: boolean;
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
  const decision = resolveSandboxBackend(
    platform(),
    findExecutable('/usr/bin/sandbox-exec') !== null,
    findExecutable('/usr/bin/bwrap') !== null,
    allowNative,
  );

  switch (decision) {
    case 'macos-sandbox-exec':
      return runWithMacSandboxExec('/usr/bin/sandbox-exec', input);
    case 'linux-bwrap':
      return runWithBwrap('/usr/bin/bwrap', input);
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

function runWithMacSandboxExec(
  sandboxExec: string,
  input: SandboxedShellInput,
): Promise<SandboxedShellResult> {
  const cwd = realpathSync(input.cwd);
  const profile = [
    '(version 1)',
    '(deny default)',
    '(allow process*)',
    '(allow sysctl-read)',
    '(allow file-read*)',
    `(allow file-write* (subpath "${escapeSandboxString(cwd)}"))`,
    '(deny network*)',
  ].join('\n');

  return new Promise((resolve) => {
    execFile(
      sandboxExec,
      ['-p', profile, '/bin/bash', '--noprofile', '--norc', '-lc', input.command],
      {
        cwd,
        timeout: input.timeoutMs,
        maxBuffer: 1024 * 1024,
        encoding: 'utf-8',
      },
      (err, stdout, stderr) => {
        const error = err ? String(stderr || err.message) : undefined;
        resolve({
          content: String(stdout ?? ''),
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
): Promise<SandboxedShellResult> {
  const cwd = realpathSync(input.cwd);
  // Create a minimal container: read-only root, writable cwd, no network
  const args = [
    '--ro-bind', '/', '/',
    '--bind', cwd, cwd,
    '--chdir', cwd,
    '--unshare-net',
    '--die-with-parent',
    '--proc', '/proc',
    '--dev', '/dev',
    '--tmpfs', '/tmp',
    '--', '/bin/bash', '--noprofile', '--norc', '-lc', input.command,
  ];

  return new Promise((resolve) => {
    execFile(
      bwrapPath,
      args,
      {
        cwd,
        timeout: input.timeoutMs,
        maxBuffer: 1024 * 1024,
        encoding: 'utf-8',
      },
      (err, stdout, stderr) => {
        const error = err ? String(stderr || err.message) : undefined;
        resolve({
          content: String(stdout ?? ''),
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
      },
      (err, stdout, stderr) => {
        // Prepend a sandbox warning so the model knows it's unconstrained
        const warning = '[sandbox: native — no filesystem/network isolation]\n';
        const error = err ? String(stderr || err.message) : undefined;
        resolve({
          content: warning + String(stdout ?? ''),
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
