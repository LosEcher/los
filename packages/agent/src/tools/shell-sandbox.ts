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

export interface SandboxedShellResult {
  content: string;
  error?: string;
  sandbox: string;
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

export async function runSandboxedShell(input: SandboxedShellInput): Promise<SandboxedShellResult> {
  // 1. macOS: sandbox-exec
  if (platform() === 'darwin') {
    const sandboxExec = findExecutable('/usr/bin/sandbox-exec');
    if (sandboxExec) {
      return runWithMacSandboxExec(sandboxExec, input);
    }
    log.warn('macOS detected but sandbox-exec not found; falling back to native');
    return runWithNativeShell(input);
  }

  // 2. Linux: bubblewrap (bwrap)
  if (platform() === 'linux') {
    const bwrap = findExecutable('/usr/bin/bwrap');
    if (bwrap) {
      return runWithBwrap(bwrap, input);
    }
    log.warn('Linux detected but bwrap not found; falling back to native (containerized env is acceptable)');
    return runWithNativeShell(input);
  }

  // 3. Other platforms: native fallback
  log.warn(`Platform ${platform()} has no sandbox; using native shell fallback`);
  return runWithNativeShell(input);
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
