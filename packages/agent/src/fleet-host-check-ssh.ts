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

export type FleetHostPlatform = HostSshTarget['platform'];
export type FleetHostCheckStatus = 'ok' | 'degraded' | 'failed' | 'skipped';

export interface FleetHostTarget extends HostSshTarget {
  nodeId: string;
  minIntervalMs: number;
}

export interface FleetHostCheckResult {
  nodeId: string;
  sshHost: string;
  platform: FleetHostPlatform;
  status: FleetHostCheckStatus;
  skippedReason?: 'cooldown' | 'disabled' | 'dry_run_plan';
  durationMs: number;
  unitActive?: string;
  healthOk?: boolean;
  healthSnippet?: string;
  listenOk?: boolean | null;
  memAvailableMb?: number;
  memTotalMb?: number;
  swapUsedMb?: number;
  swapTotalMb?: number;
  diskUsedPct?: number | null;
  diskAvailableMb?: number | null;
  detail: string;
  error?: string;
}

export function matchField(text: string, key: string): string | undefined {
  const m = text.match(new RegExp(`^${key}=(.*)$`, 'mi'));
  return m?.[1]?.trim();
}

export function parsePair(line: string | undefined): { a: number; b: number } | undefined {
  if (!line || line === 'n/a') return undefined;
  const parts = line.trim().split(/\s+/).map(Number);
  if (parts.length >= 2 && parts.every((n) => Number.isFinite(n))) {
    return { a: parts[0]!, b: parts[1]! };
  }
  return undefined;
}

export function parseHostCheckOutput(
  target: FleetHostTarget,
  stdout: string,
  stderr: string,
  exitCode: number | null,
  durationMs: number,
  error?: string,
): FleetHostCheckResult {
  if (error) {
    return {
      nodeId: target.nodeId,
      sshHost: target.sshHost,
      platform: target.platform,
      status: 'failed',
      durationMs,
      detail: stderr || error,
      error,
    };
  }

  const text = `${stdout}\n${stderr}`;
  const unitLine = matchField(text, 'UNIT');
  const healthLine = matchField(text, 'HEALTH');
  const listenLine = matchField(text, 'LISTEN');
  const memLine = matchField(text, 'MEM');
  const swapLine = matchField(text, 'SWAP');
  const diskLine = matchField(text, 'DISK');

  const unitActive = unitLine?.trim().toLowerCase();
  const unitOk = unitActive === 'active'
    || unitActive === 'running'
    || unitActive === 'ready';
  const healthOk = Boolean(healthLine && /"status"\s*:\s*"ok"|status.:.ok/i.test(healthLine));
  const listenOk = target.platform === 'windows'
    ? null
    : Boolean(listenLine && listenLine.includes(String(target.healthPort)));

  const mem = parsePair(memLine);
  const swap = parsePair(swapLine);
  // df -P / 的 DISK 行：`5% 12345678`（使用率 + 可用 KB，1K blocks）。兼容 'n/a'。
  let diskUsedPct: number | null = null;
  let diskAvailableMb: number | null = null;
  if (diskLine && diskLine !== 'n/a') {
    const dp = diskLine.trim().split(/\s+/);
    const pct = Number((dp[0] ?? '').replace('%', ''));
    const availKb = Number(dp[1]);
    if (Number.isFinite(pct)) diskUsedPct = pct;
    if (Number.isFinite(availKb)) diskAvailableMb = Math.round(availKb / 1024);
  }

  let status: FleetHostCheckStatus = 'ok';
  if (!unitOk || !healthOk) status = 'failed';
  else if (listenOk === false) status = 'degraded';
  else if (diskUsedPct != null && diskUsedPct >= 90) status = 'degraded';
  else if (exitCode !== 0 && exitCode !== null) status = 'degraded';

  const detail = [
    `unit=${unitActive ?? 'n/a'}`,
    `health=${healthOk ? 'ok' : 'bad'}`,
    listenOk === null ? null : `listen=${listenOk ? 'ok' : 'missing'}`,
    mem ? `mem_avail_mb=${mem.b}` : null,
    swap ? `swap_used_mb=${swap.b}` : null,
    diskUsedPct != null ? `disk_used_pct=${diskUsedPct}` : null,
  ].filter(Boolean).join(' ');

  return {
    nodeId: target.nodeId,
    sshHost: target.sshHost,
    platform: target.platform,
    status,
    durationMs,
    unitActive: unitActive ?? undefined,
    healthOk,
    healthSnippet: healthLine?.slice(0, 200),
    listenOk,
    memTotalMb: mem?.a,
    memAvailableMb: mem?.b,
    swapTotalMb: swap?.a,
    swapUsedMb: swap?.b,
    diskUsedPct,
    diskAvailableMb,
    detail,
    error: status === 'failed' ? detail : undefined,
  };
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
    "DISK=$(df -P / 2>/dev/null | awk 'NR==2{print $5,$4}')",
    'echo "DISK=$DISK"',
  ].join('\n');
}

export function buildWindowsRemoteScript(target: HostSshTarget): string {
  const port = target.healthPort;
  const unit = target.unitName.replace(/[^a-zA-Z0-9_.@-]/g, '') || 'los-executor';
  // Windows executor is supervised by a service (nssm los-executor), not a
  // scheduled task. Locale-independent: service existence exit code + the
  // non-localized SCM state token RUNNING. Health is the process truth surface.
  return [
    '@echo off',
    `sc query ${unit} >nul 2>&1`,
    'if errorlevel 1 (echo UNIT=missing) else (',
    `  sc query ${unit} | findstr /C:"RUNNING" >nul 2>&1`,
    '  if errorlevel 1 (echo UNIT=stopped) else (echo UNIT=running)',
    ')',
    `curl -sS -m 3 http://127.0.0.1:${port}/health > %TEMP%\\los_health.txt 2>&1`,
    `set /p HEALTH=<%TEMP%\\los_health.txt`,
    `echo HEALTH=%HEALTH%`,
    'echo LISTEN=n/a',
    'echo MEM=n/a',
    'echo SWAP=n/a',
    'echo DISK=n/a',
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

export type FleetHostRepairAction = 'start' | 'restart';

/**
 * Repair scripts are idempotent:
 * - start: no-op when the unit/service is already up.
 * - restart: stops (if needed) and starts; safe when already inactive.
 * Output carries REPAIR_EXIT= and REPAIR_STATE= for the caller to parse.
 */
export function buildLinuxRepairScript(target: HostSshTarget, action: FleetHostRepairAction): string {
  const unit = target.unitName.replace(/[^a-zA-Z0-9_.@-]/g, '');
  const start = [
    'set +e',
    `systemctl is-active ${unit} >/dev/null 2>&1 || systemctl start ${unit}`,
    `echo "REPAIR_EXIT=$?"`,
    `systemctl is-active ${unit} >/dev/null 2>&1 && echo REPAIR_STATE=active || echo REPAIR_STATE=inactive`,
  ];
  const restart = [
    'set +e',
    `systemctl restart ${unit}`,
    `echo "REPAIR_EXIT=$?"`,
    `systemctl is-active ${unit} >/dev/null 2>&1 && echo REPAIR_STATE=active || echo REPAIR_STATE=inactive`,
  ];
  return (action === 'restart' ? restart : start).join('\n');
}

export function buildWindowsRepairScript(target: HostSshTarget, action: FleetHostRepairAction): string {
  const unit = target.unitName.replace(/[^a-zA-Z0-9_.@-]/g, '');
  const start = [
    '@echo off',
    `sc query ${unit} | findstr /C:"RUNNING" >nul 2>&1 || net start ${unit}`,
    'echo REPAIR_EXIT=%ERRORLEVEL%',
    `sc query ${unit} | findstr /C:"RUNNING" >nul 2>&1 && echo REPAIR_STATE=running || echo REPAIR_STATE=stopped`,
  ];
  const restart = [
    '@echo off',
    `net stop ${unit} >nul 2>&1`,
    `net start ${unit}`,
    'echo REPAIR_EXIT=%ERRORLEVEL%',
    `sc query ${unit} | findstr /C:"RUNNING" >nul 2>&1 && echo REPAIR_STATE=running || echo REPAIR_STATE=stopped`,
  ];
  return (action === 'restart' ? restart : start).join('\r\n');
}

export async function runHostRepair(
  target: HostSshTarget,
  action: FleetHostRepairAction,
  timeoutMs: number,
  runner: typeof runSshCommand = runSshCommand,
  windowsRunner: typeof runWindowsSshCommand = runWindowsSshCommand,
): Promise<SshCommandResult> {
  if (target.platform === 'windows') {
    return windowsRunner(target.sshHost, buildWindowsRepairScript(target, action), timeoutMs);
  }
  return runner(target.sshHost, buildLinuxRepairScript(target, action), timeoutMs);
}

export function parseRepairOutput(text: string): { exitCode?: number; state?: string } {
  const exit = text.match(/^REPAIR_EXIT=(\d+)$/mi);
  const state = text.match(/^REPAIR_STATE=(.+)$/mi);
  return {
    exitCode: exit ? Number(exit[1]) : undefined,
    state: state?.[1]?.trim().toLowerCase(),
  };
}
