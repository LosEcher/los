import { existsSync } from 'node:fs';
import { spawn, execSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import type {
  NodeCommandRuntime,
  NodeCommandRuntimeContext,
  NodeCommandRuntimeResult,
} from '@los/agent/node-commands';

const ROOT = resolve(process.cwd());
const EXECUTOR_HELPER = resolve(ROOT, 'tools', 'executor.sh');
const RUNNER_LOG = resolve(ROOT, '.los-runtime', 'node-command-runner.log');

/**
 * 受治理的检查执行（2026-10-11）：在**节点本地**跑一条声明式 requiredCheck。
 * 远端 run 的工作区是节点本地的，检查必须在同一台机器上跑；命令由网关以 agent key 签发送达。
 */
function runGovernedCheck(context: NodeCommandRuntimeContext): Promise<NodeCommandRuntimeResult> {
  const args = (context.input.args ?? {}) as Record<string, unknown>;
  const command = typeof args.command === 'string' ? args.command.trim() : '';
  if (!command) {
    return Promise.resolve({ status: 'failed', error: 'run-check requires args.command' });
  }
  const cwd = typeof args.cwd === 'string' && args.cwd ? args.cwd : ROOT;
  const requested = typeof args.timeoutMs === 'number' && args.timeoutMs > 0 ? args.timeoutMs : 120_000;
  const timeoutMs = Math.min(requested, 600_000);
  return new Promise<NodeCommandRuntimeResult>(resolve => {
    const child = spawn(command, { cwd, shell: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const cap = (value: string) => (value.length > 8_000 ? value.slice(0, 8_000) : value);
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM'); }, timeoutMs);
    child.stdout?.on('data', (chunk: Buffer) => { stdout = cap(stdout + chunk.toString('utf8')); });
    child.stderr?.on('data', (chunk: Buffer) => { stderr = cap(stderr + chunk.toString('utf8')); });
    child.on('error', (error: Error) => {
      clearTimeout(timer);
      resolve({ status: 'failed', error: error.message });
    });
    child.on('close', (code: number | null) => {
      clearTimeout(timer);
      const exitCode = code ?? null;
      resolve({
        status: !timedOut && exitCode === 0 ? 'succeeded' : 'failed',
        output: { exitCode, stdout: stdout.trim(), stderr: stderr.trim(), timedOut, cwd, command },
        ...(timedOut
          ? { error: `check timed out after ${timeoutMs}ms` }
          : exitCode === 0 ? {} : { error: stderr.trim() || `exit ${exitCode}` }),
      });
    });
  });
}

export function createExecutorNodeCommandRuntime(): NodeCommandRuntime {
  // Windows: use PowerShell for maintenance commands.
  // upgrade runs git pull + process.exit (relies on process manager to restart).
  if (process.platform === 'win32') {
    return {
      'run-check': runGovernedCheck,
      restart: async (context) => {
        // Schedule a delayed restart via detached powershell so the HTTP
        // response can be sent before the process exits.
        spawn('powershell', [
          '-Command',
          `Start-Sleep -Seconds 2; Get-Process -Id ${process.pid} -ErrorAction SilentlyContinue | Stop-Process -Force`,
        ], { detached: true, stdio: 'ignore' }).unref();
        return {
          status: 'accepted',
          output: { note: 'restart scheduled (process will exit in 2s)', commandId: context.commandId },
        };
      },
      upgrade: async (context) => {
        try {
          execSync('git pull', { cwd: ROOT, timeout: 30_000, stdio: 'pipe' });
        } catch (err: any) {
          return {
            status: 'failed',
            output: { error: `git pull failed: ${err?.message ?? String(err)}` },
          };
        }
        spawn('powershell', [
          '-Command',
          `Start-Sleep -Seconds 2; Get-Process -Id ${process.pid} -ErrorAction SilentlyContinue | Stop-Process -Force`,
        ], { detached: true, stdio: 'ignore' }).unref();
        return {
          status: 'accepted',
          output: { note: 'upgrade: git pull done, restart scheduled', commandId: context.commandId },
        };
      },
      rollback: async (context) => {
        try {
          execSync('git checkout HEAD~1', { cwd: ROOT, timeout: 30_000, stdio: 'pipe' });
        } catch (err: any) {
          return {
            status: 'failed',
            output: { error: `git checkout failed: ${err?.message ?? String(err)}` },
          };
        }
        spawn('powershell', [
          '-Command',
          `Start-Sleep -Seconds 2; Get-Process -Id ${process.pid} -ErrorAction SilentlyContinue | Stop-Process -Force`,
        ], { detached: true, stdio: 'ignore' }).unref();
        return {
          status: 'accepted',
          output: { note: 'rollback: git checkout done, restart scheduled', commandId: context.commandId },
        };
      },
    };
  }
  return {
    'run-check': runGovernedCheck,
    restart: async (context) => scheduleMaintenance('restart', context),
    upgrade: async (context) => scheduleMaintenance('upgrade', context),
    rollback: async (context) => scheduleMaintenance('restart', context, 'rollback fallback uses restart helper'),
  };
}

function scheduleMaintenance(
  command: 'restart' | 'upgrade',
  context: NodeCommandRuntimeContext,
  note?: string,
): NodeCommandRuntimeResult {
  if (!existsSync(EXECUTOR_HELPER)) {
    throw new Error(`executor helper not found: ${EXECUTOR_HELPER}`);
  }

  const path = mergePath(process.env.PATH);
  const commandLine = [
    `export PATH=${shellQuote(path)}`,
    'mkdir -p .los-runtime',
    `echo "[node-command-runner] helper=${command} path=$PATH" >> ${shellQuote(RUNNER_LOG)}`,
    `command -v pnpm >> ${shellQuote(RUNNER_LOG)} 2>&1`,
    `bash ./tools/executor.sh ${command} >> ${shellQuote(RUNNER_LOG)} 2>&1`,
  ].join('; ');
  const child = spawn('/bin/bash', ['-lc', commandLine], {
    cwd: ROOT,
    detached: true,
    stdio: 'ignore',
    env: {
      ...process.env,
      PATH: path,
      LOS_CLIENT_CWD: process.env.LOS_CLIENT_CWD ?? ROOT,
    },
  });
  child.unref();

  return {
    status: 'accepted',
    output: {
      note: note ?? `${command} scheduled`,
      helper: 'tools/executor.sh',
      helperCommand: command,
      childPid: child.pid ?? null,
      logPath: RUNNER_LOG,
      commandId: context.commandId,
    },
  };
}

function mergePath(value: string | undefined): string {
  const home = process.env.HOME;
  const entries = [
    ...(value ?? '').split(':'),
    dirname(process.execPath),
    ...(home ? [`${home}/Library/pnpm`, `${home}/.local/share/pnpm`] : []),
    ...(home ? [`${home}/Library/Application Support/fnm/aliases/default/bin`] : []),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
    '/usr/sbin',
    '/sbin',
  ].filter(Boolean);
  return Array.from(new Set(entries)).join(':');
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
