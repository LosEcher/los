import { execFile } from 'node:child_process';
import { accessSync, constants, realpathSync } from 'node:fs';
import { platform } from 'node:os';

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

export async function runSandboxedShell(input: SandboxedShellInput): Promise<SandboxedShellResult> {
  const sandboxExec = findExecutable('/usr/bin/sandbox-exec');
  if (platform() === 'darwin' && sandboxExec) {
    return runWithMacSandboxExec(sandboxExec, input);
  }

  return {
    content: '',
    error: 'No supported shell sandbox is available for run_shell',
    sandbox: 'unavailable',
  };
}

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
