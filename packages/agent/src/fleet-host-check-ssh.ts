/**
 * SSH remote scripts + transport for fleet host checks (P2).
 */

import { spawn } from 'node:child_process';

/** Minimal target fields needed for remote script generation. */
export interface HostSshTarget {
  sshHost: string;
  platform: 'linux' | 'windows';
  healthPort: number;
  unitName: string;
}

export interface SshCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  error?: string;
}

export function buildLinuxRemoteScript(target: HostSshTarget): string {
  const port = target.healthPort;
  const unit = target.unitName.replace(/[^a-zA-Z0-9_.@-]/g, '');
  return [
    'set +e',
    `UNIT_STATE=$(systemctl is-active ${unit} 2>/dev/null || echo missing)`,
    `echo "UNIT=$UNIT_STATE"`,
    `HEALTH=$(curl -fsS -m 3 http://127.0.0.1:${port}/health 2>&1 | head -c 400 | tr '\\n' ' ')`,
    'echo "HEALTH=$HEALTH"',
    `LISTEN=$(ss -lntp 2>/dev/null | grep -E ":${port}\\b" | head -1 | tr -s ' ' || true)`,
    'echo "LISTEN=$LISTEN"',
    "MEM=$(free -m | awk '/^Mem:/{print $2,$7}')",
    'echo "MEM=$MEM"',
    "SWAP=$(free -m | awk '/^Swap:/{print $2,$3}')",
    'echo "SWAP=$SWAP"',
  ].join('\n');
}

export function buildWindowsRemoteScript(target: HostSshTarget): string {
  const port = target.healthPort;
  const task = target.unitName.replace(/[^a-zA-Z0-9_.@-]/g, '') || 'los-executor';
  // Locale-independent: task existence exit code only (Status: strings are
  // localized on zh-CN Windows). Health is the process truth surface.
  return [
    '@echo off',
    `schtasks /Query /TN ${task} >nul 2>&1`,
    'if errorlevel 1 (echo UNIT=missing) else (echo UNIT=ready)',
    `curl -sS -m 3 http://127.0.0.1:${port}/health > %TEMP%\\los_health.txt 2>&1`,
    `set /p HEALTH=<%TEMP%\\los_health.txt`,
    `echo HEALTH=%HEALTH%`,
    'echo LISTEN=n/a',
    'echo MEM=n/a',
    'echo SWAP=n/a',
  ].join('\r\n');
}

function spawnSsh(
  args: string[],
  stdinPayload: string,
  timeoutMs: number,
): Promise<SshCommandResult> {
  return new Promise((resolve) => {
    const child = spawn('ssh', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      resolve({ stdout, stderr, exitCode: null, error: `ssh timeout after ${timeoutMs}ms` });
    }, timeoutMs);

    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout, stderr, exitCode: null, error: err.message });
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout, stderr, exitCode: code });
    });
    child.stdin.write(stdinPayload);
    child.stdin.end();
  });
}

const SSH_BASE = [
  '-o', 'BatchMode=yes',
  '-o', 'ConnectTimeout=8',
  '-o', 'StrictHostKeyChecking=accept-new',
] as const;

export async function runSshCommand(
  sshHost: string,
  remoteScript: string,
  timeoutMs: number,
): Promise<SshCommandResult> {
  return spawnSsh([...SSH_BASE, sshHost, 'bash -s'], remoteScript, timeoutMs);
}

export async function runWindowsSshCommand(
  sshHost: string,
  remoteScript: string,
  timeoutMs: number,
): Promise<SshCommandResult> {
  // Write batch via stdin into a temp .cmd then execute (Windows OpenSSH + cmd).
  return spawnSsh(
    [
      ...SSH_BASE,
      sshHost,
      'cmd /q /c "more > %TEMP%\\los-host-check.cmd & call %TEMP%\\los-host-check.cmd"',
    ],
    remoteScript,
    timeoutMs,
  );
}

export async function runHostSsh(
  target: HostSshTarget,
  timeoutMs: number,
  runner: typeof runSshCommand = runSshCommand,
  windowsRunner: typeof runWindowsSshCommand = runWindowsSshCommand,
): Promise<SshCommandResult> {
  if (target.platform === 'windows') {
    return windowsRunner(target.sshHost, buildWindowsRemoteScript(target), timeoutMs);
  }
  return runner(target.sshHost, buildLinuxRemoteScript(target), timeoutMs);
}
