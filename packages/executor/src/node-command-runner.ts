import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import type {
  NodeCommandRuntime,
  NodeCommandRuntimeContext,
  NodeCommandRuntimeResult,
} from '@los/agent/node-commands';

const ROOT = resolve(process.cwd());
const EXECUTOR_HELPER = resolve(ROOT, 'tools', 'executor.sh');
const RUNNER_LOG = resolve(ROOT, '.los-runtime', 'node-command-runner.log');

export function createExecutorNodeCommandRuntime(): NodeCommandRuntime {
  // Windows: maintenance commands not yet supported (requires bash + executor.sh)
  if (process.platform === 'win32') {
    const notSupported = (command: string) => async (_context: NodeCommandRuntimeContext): Promise<NodeCommandRuntimeResult> => ({
      status: 'rejected',
      output: { note: `${command} not supported on Windows` },
    });
    return {
      restart: notSupported('restart'),
      upgrade: notSupported('upgrade'),
      rollback: notSupported('rollback'),
    };
  }
  return {
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
