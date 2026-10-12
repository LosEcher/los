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
 * Windows 上把网关给的 POSIX 风格 cwd 翻成存在的路径。
 *
 * ⚠️ 2026-10-11 实测（这是 `spawn C:\Windows\system32\cmd.exe ENOENT` 的**真根因**，
 * 与"cmd.exe 不存在"无关）：
 *
 * - `placement.ts` 的探测固定用 `cwd:'/tmp'`；Windows 上没有 `C:\tmp`；
 * - `spawn(cmd, {shell:true, cwd})` 在 **cwd 不存在**时抛 `ENOENT`，而 Node 把**壳程序的名字**
 *   放进消息里 ⇒ 报出来像"找不到 cmd.exe"，实际是"找不到 cwd"。同一台机器上
 *   `cwd:'C:/Windows/Temp'` 的命令是成功的（本轮实测）——**这就是判据**。
 * - `desktop-r45553o` 的 `/tmp` 恰好能被解析（Git Bash 装的 `C:\tmp`），于是同一份探测
 *   在它上面走得更远、以 POSIX 语法错误收场 ⇒ **两台机器报两种错，根因是同一层**。
 *
 * 判据（可迁移）：**"环境报某文件找不到"必须先核对"这个进程的工作目录存在吗"**，
 * 否则会把一个不存在的目录误读成一个缺失的二进制。
 */
export function _normalizeWindowsCwd(cwd: string): { cwd: string; note?: string } {
  // 先统一分隔符与尾斜杠（`C:\los\x\` 与 `C:/los/x` 是同一个目录）。
  const slashed = cwd.split('\\').join('/');
  const candidate = slashed.replace(/\/+$/, '');
  const known: Record<string, string> = { '': ROOT.split('\\').join('/'), '/tmp': 'C:/Windows/Temp' };
  const mapped = known[candidate];
  if (mapped) {
    return candidate === '/tmp'
      ? { cwd: mapped, note: `cwd /tmp is POSIX-only; ran in ${mapped} instead` }
      : { cwd: mapped };
  }
  // `/…` 这种 POSIX 绝对路径在 Windows 上可能指向驱动器根下的同名目录（`C:\opt\…`）；
  // 它**不是**自动可信的 —— 交给 spawn 去判，失败了由下面的 error handler 如实报告。
  // ⚠️ 这里必须返回**归一后的 candidate**：第一版返回原始 `cwd`，于是"分隔符/尾斜杠归一"
  // 只对 `/tmp` 这一支生效（单测当场抓到——这就是把纯函数抽出来的价值）。
  return { cwd: candidate };
}

/** PowerShell 的绝对路径：不依赖服务会话的 PATH（该会话的 PATH 与登录会话并不一致）。 */
const WINDOWS_POWERSHELL = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';

/**
 * **纯函数**：把一次 `run-check` 翻译成"用哪个壳、跑在哪"。
 *
 * 抽出来的唯一目的是**可测**：`process.platform` 在本机永远是 `darwin`，Windows 分支
 * 否则只能靠真机验证——而真机验证恰恰是最贵、最晚发现问题的地方（本次实测就是如此：
 * 两台机器报两种错、根因却是同一层）。这里是"平台分派"这件事的机械判据面。
 */
export function _planGovernedCheckSpawn(input: {
  command: string;
  requestedCwd: string;
  platform: string;
}): { exe: string; argv: string[]; cwd: string; note?: string } {
  if (input.platform === 'win32') {
    const normalized = _normalizeWindowsCwd(input.requestedCwd);
    return {
      exe: WINDOWS_POWERSHELL,
      argv: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', input.command],
      cwd: normalized.cwd,
      ...(normalized.note ? { note: normalized.note } : {}),
    };
  }
  return { exe: input.command, argv: [], cwd: input.requestedCwd };
}

/**
 * 受治理的检查执行（2026-10-11）：在**节点本地**跑一条声明式 requiredCheck。
 * 远端 run 的工作区是节点本地的，检查必须在同一台机器上跑；命令由网关以 agent key 签发送达。
 *
 * ## 平台分派（2026-10-11 晚，S8）
 *
 * `shell:true` 在 Windows 上等于 **cmd.exe**，而 cmd.exe **读不懂 POSIX**（实测
 * `'d' 不是内部或外部命令`）——这正是 Windows 节点拿不到 agent 派发的直接原因。
 * 两台 Windows 上**同时存在**的唯一 shell 是 PowerShell，且 agent 侧的 `windows-acl`
 * 沙箱本身也是 spawn `powershell.exe`（`shell-sandbox-windows.ts:151`）⇒ 这里让
 * `run-check` **真的经 PowerShell 执行**，而不是把 PowerShell 文本拼给 cmd.exe 解析
 * （后者会让 `-NoProfile` 这类 token 被当成命令名，是**假修**）。
 *
 * 协议不变：仍然是 `{exitCode, stdout, stderr}`，仍然要求"退出码 0 且输出可解析"。
 * **换的是语言，不是判据。**
 */
function runGovernedCheck(context: NodeCommandRuntimeContext): Promise<NodeCommandRuntimeResult> {
  const args = (context.input.args ?? {}) as Record<string, unknown>;
  const command = typeof args.command === 'string' ? args.command.trim() : '';
  if (!command) {
    return Promise.resolve({ status: 'failed', error: 'run-check requires args.command' });
  }
  const requestedCwd = typeof args.cwd === 'string' && args.cwd ? args.cwd : ROOT;
  const requested = typeof args.timeoutMs === 'number' && args.timeoutMs > 0 ? args.timeoutMs : 120_000;
  const timeoutMs = Math.min(requested, 600_000);

  const isWindows = process.platform === 'win32';
  const plan = _planGovernedCheckSpawn({ command, requestedCwd, platform: process.platform });
  const cwd = plan.cwd;
  const cwdNote = plan.note;
  return new Promise<NodeCommandRuntimeResult>(resolve => {
    const child = isWindows
      ? spawn(plan.exe, plan.argv, { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
      : spawn(plan.exe, { cwd, shell: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const cap = (value: string) => (value.length > 8_000 ? value.slice(0, 8_000) : value);
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM'); }, timeoutMs);
    child.stdout?.on('data', (chunk: Buffer) => { stdout = cap(stdout + chunk.toString('utf8')); });
    child.stderr?.on('data', (chunk: Buffer) => { stderr = cap(stderr + chunk.toString('utf8')); });
    child.on('error', (error: Error) => {
      clearTimeout(timer);
      // `spawn cmd.exe ENOENT` 这种消息**指错了对象**（真因见 `_normalizeWindowsCwd` 的注释：
      // 是 cwd 不存在，不是壳不存在）。所以把 cwd 与壳一起报出来——否则下一次还会误诊。
      resolve({
        status: 'failed',
        output: { cwd, command, ...(isWindows ? { shell: 'powershell' } : {}) },
        error: `${error.message} (cwd=${cwd}${isWindows ? ', shell=powershell' : ''})`,
      });
    });
    child.on('close', (code: number | null) => {
      clearTimeout(timer);
      const exitCode = code ?? null;
      resolve({
        status: !timedOut && exitCode === 0 ? 'succeeded' : 'failed',
        output: {
          exitCode, stdout: stdout.trim(), stderr: stderr.trim(), timedOut, cwd, command,
          // 路径被改写时必须留痕：否则证据面看不出"这次跑的 cwd 不是请求的那个"。
          ...(cwdNote ? { cwdNote } : {}),
          ...(isWindows ? { shell: 'powershell' } : {}),
        },
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
