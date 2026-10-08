/**
 * isolation-backends.ts — 可插拔隔离后端的注册表与 probe()（ADR 0047 §5.1 C2）。
 *
 * 契约：`contracts/isolation-backend.yaml`。本文件只实现 **probe()**（能力探测），
 * 因为它是"显式指定后端不可用时 must fail-closed **带原因**"这条纪律的前提 ——
 * 没有诚实的 probe，"不可用"就无从表达，只能静默回落。
 *
 * 三条接口纪律（契约条款，不得放宽）：
 *   1. 后端**只返回原始结果**，**绝不返回 PASS/FAIL** —— 判定与三态分类属门禁层
 *   2. 后端**不得写 los 账本**（单写者 R1）
 *   3. `probe()` 必须能回答**为什么**不可用
 *
 * 本文件即纪律 1 与 2 的体现：导出的类型里**没有** verdict 字段，且这里不做任何
 * 落账；`IsolationProbeResult` 在不 available 时**强制要求** reason。
 */
import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { ManagedWorkspaceBackendId } from './managed-workspace-types.js';

const execFileAsync = promisify(execFile);

/**
 * 探测结果。**`reason` 在不 available 时是必填** —— 用联合类型把它变成编译期要求，
 * 而不是靠注释约定（"一个无法解释自己为何不可用的 probe 不是合格的 probe"）。
 */
export type IsolationProbeResult =
  | { available: true; detail: Record<string, unknown> }
  | { available: false; reason: string; detail?: Record<string, unknown> };

/** 探测上下文。只读事实，不含决策。 */
export interface IsolationProbeInput {
  /** 被隔离的仓根（工作树来源）。 */
  repository: string;
}

/**
 * 后端接口。**注意 `run()` 的返回类型里没有任何 verdict 字段** —— 见文件头纪律 1。
 */
export interface IsolationBackend {
  readonly id: ManagedWorkspaceBackendId;
  /** 本后端是否可用于该仓；不可用时必须给出原因。 */
  probe(input: IsolationProbeInput): Promise<IsolationProbeResult>;
}

/** 在 PATH 或候选绝对路径上找一个可执行文件。 */
async function which(bin: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('/usr/bin/which', [bin], { timeout: 5_000 });
    const p = stdout.trim();
    return p.length > 0 ? p : null;
  } catch {
    return null;
  }
}

/** 仓内是否存在某个 VCS 元目录。 */
function hasVcsDir(repository: string, kind: 'jj' | 'git'): boolean {
  return existsSync(join(repository, kind === 'jj' ? '.jj' : '.git'));
}

/**
 * `jj-workspace` —— 内建。纯命令编排，**除 jj 本身外不得依赖外部二进制**（契约要求）。
 */
export const jjWorkspaceBackend: IsolationBackend = {
  id: 'jj-workspace',
  async probe({ repository }) {
    if (!hasVcsDir(repository, 'jj')) {
      return {
        available: false,
        reason: `not a jj repository (no .jj directory at ${repository})`,
        detail: { repository },
      };
    }
    const bin = await which('jj');
    if (!bin) {
      return {
        available: false,
        reason: 'jj binary not found on PATH — the built-in jj backend needs only the VCS itself',
        detail: { repository },
      };
    }
    return { available: true, detail: { repository, binary: bin } };
  },
};

/**
 * `git-worktree` —— 内建。同样只依赖 git 本身。
 */
export const gitWorktreeBackend: IsolationBackend = {
  id: 'git-worktree',
  async probe({ repository }) {
    if (!hasVcsDir(repository, 'git')) {
      return {
        available: false,
        reason: `not a git repository (no .git directory at ${repository})`,
        detail: { repository },
      };
    }
    const bin = await which('git');
    if (!bin) {
      return {
        available: false,
        reason: 'git binary not found on PATH — the built-in git-worktree backend needs only the VCS itself',
        detail: { repository },
      };
    }
    return { available: true, detail: { repository, binary: bin } };
  },
};

/**
 * `docker` —— **委托 `sandbox-run`**（容器编排属 L3 工具领域，不在 los 重写）。
 *
 * 因此这里探两件事：VCS 可用性（worktree 是 sandbox-run 的默认后端，也是 docker
 * 路径的入口）与 **sandbox-run 是否在 PATH 上**。后者缺失时必须给出可操作的
 * 原因（装它 / 设 PATH），而不是让调用方看到一个裸的 ENOENT。
 */
export const dockerBackend: IsolationBackend = {
  id: 'docker',
  async probe({ repository }) {
    const hasGit = hasVcsDir(repository, 'git');
    const hasJj = hasVcsDir(repository, 'jj');
    if (!hasGit && !hasJj) {
      return {
        available: false,
        reason: `no git or jj repository at ${repository} — sandbox-run needs a VCS checkout to isolate from`,
        detail: { repository },
      };
    }
    const bin = await which('sandbox-run');
    if (!bin) {
      return {
        available: false,
        reason: 'sandbox-run not found on PATH — the docker backend is delegated to it; install sandbox-run or set PATH',
        detail: { repository, delegatedTo: 'sandbox-run --backend docker' },
      };
    }
    return {
      available: true,
      detail: { repository, binary: bin, delegatedTo: 'sandbox-run --backend docker' },
    };
  },
};

/** 注册表：id → backend。**los 拥有这张表**（账本职责），backend 不注册自己。 */
/**
 * 原始执行结果。**里面没有 verdict 字段**（契约纪律 1）。
 *
 * `exitCode: null` 表示**命令未曾运行**（例如 sandbox-run 因为变更集为空而
 * fail-closed 拒绝）—— 这与 `exitCode: 0`（跑过且成功）**是两件事**，必须区分，
 * 否则"没跑"会被读成"通过"。
 */
export interface RawExecutionResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  /** 观测到的原始事实（不是判定）。用于排障与审计。 */
  observed?: Record<string, unknown>;
}

export interface IsolationRunInput {
  /** 仓根（sandbox-run 的 cwd，用于 scope 检测）。 */
  repository: string;
  /** 要执行的验证命令（shell 原文）。 */
  command: string;
  timeoutMs: number;
}

/** 后端可执行验证。 */
export interface IsolationExecutor {
  execute(input: IsolationRunInput): Promise<RawExecutionResult>;
}

/**
 * `sandbox-run` 的 JSON 报告里我们关心的部分。
 *
 * **实测契约（2026-10-08，sandbox-run 0.1.3）**：
 *   命令成功      → `verify.exitCode = 0`，进程退出码 0，verdict "pass"
 *   命令失败      → `verify.exitCode = 7`（**真实码**），进程退出码 **1**，verdict "fail"
 *   变更集为空    → `verify.exitCode = null`，进程退出码 1，verdict "rejected"
 *   工具自身错    → 进程退出码 2
 *
 * 关键：**进程退出码跨情形复用**（fail 与 rejected 都是 1），所以不能拿它当
 * 命令结果；真实结果只在 `verify.exitCode` 里。这正是"后端只返回原始结果"的
 * 意义 —— 适配器必须把真实码取出来交给上层，而不是把进程码当成命令码。
 */
export function parseSandboxRunReport(stdout: string): {
  exitCode: number | null;
  verdict: string | null;
  backend: string | null;
  detail: string | null;
} | null {
  try {
    const d = JSON.parse(stdout) as Record<string, unknown>;
    const verify = (d.verify ?? {}) as Record<string, unknown>;
    const sandbox = (d.sandbox ?? {}) as Record<string, unknown>;
    const code = verify.exitCode;
    return {
      exitCode: typeof code === 'number' ? code : null,
      verdict: typeof d.verdict === 'string' ? d.verdict : null,
      backend: typeof sandbox.backend === 'string' ? sandbox.backend : null,
      detail: typeof sandbox.detail === 'string' ? sandbox.detail : null,
    };
  } catch {
    return null;
  }
}

/**
 * 用 `sandbox-run` 在隔离环境中执行验证（C3：docker 后端**委托**它）。
 *
 * 纪律 1 的体现：返回 `RawExecutionResult`，**不含 verdict**。报告里的 `verdict`
 * 与 `sandbox.backend` 只作为 `observed` 原始事实透传 —— 是否把它当结论，由门禁层
 * 决定（把"判不了"压成"失败"正是 2026-10-08 假红事故的机制）。
 */
export async function executeViaSandboxRun(input: IsolationRunInput): Promise<RawExecutionResult> {
  const bin = await which('sandbox-run');
  if (!bin) {
    // 环境故障 ⇒ **明示**，不要伪装成"命令失败"。
    return {
      exitCode: null,
      stdout: '',
      stderr: 'sandbox-run not found on PATH — cannot execute the delegated isolation backend',
      durationMs: 0,
      observed: { spawnError: 'sandbox-run-missing' },
    };
  }

  const timeoutSecs = Math.max(1, Math.ceil(input.timeoutMs / 1000));
  const started = Date.now();
  return await new Promise<RawExecutionResult>((resolve) => {
    const child = spawn(
      bin,
      ['--scope-from-git', '--no-log', '--timeout', String(timeoutSecs), '--', '/bin/sh', '-c', input.command],
      { cwd: input.repository, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      resolve({
        exitCode: null, stdout,
        stderr: `${stderr}\nsandbox-run exceeded ${timeoutSecs}s and was killed`,
        durationMs: Date.now() - started, observed: { spawnError: 'timeout' },
      });
    }, input.timeoutMs + 15_000);

    child.stdout.on('data', (b: Buffer) => { stdout += b.toString('utf8'); });
    child.stderr.on('data', (b: Buffer) => { stderr += b.toString('utf8'); });
    child.on('error', (e: Error) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      // spawn 失败（二进制不可执行等）⇒ 环境故障，exitCode 保持 null
      resolve({
        exitCode: null, stdout, stderr: `${stderr}\n${e.message}`,
        durationMs: Date.now() - started, observed: { spawnError: e.message },
      });
    });
    child.on('close', (code: number | null) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      const report = parseSandboxRunReport(stdout);
      resolve({
        // 关键：**不用进程码**当命令结果；命令是否跑过看 report.exitCode
        exitCode: report ? report.exitCode : null,
        stdout, stderr,
        durationMs: Date.now() - started,
        observed: {
          processExitCode: code,               // 原始事实，含 fail/rejected 复用
          sandboxVerdict: report?.verdict ?? null,
          sandboxBackend: report?.backend ?? null,
          sandboxDetail: report?.detail ?? null,
        },
      });
    });
  });
}

export const ISOLATION_BACKENDS: Readonly<Record<ManagedWorkspaceBackendId, IsolationBackend>> = {
  'jj-workspace': jjWorkspaceBackend,
  'git-worktree': gitWorktreeBackend,
  'docker': dockerBackend,
};

/** 已声明的后端 id（供配置校验与错误信息）。 */
export function declaredBackendIds(): ManagedWorkspaceBackendId[] {
  return Object.keys(ISOLATION_BACKENDS) as ManagedWorkspaceBackendId[];
}

/**
 * `auto` 解析：按仓的 VCS 挑内建后端。
 *
 * **不猜**：既不是 jj 也不是 git 仓时返回 null，由调用方 fail-closed 报因
 * （契约的 backendSelection.autoResolution 明写 "else: fail closed with a
 * reason (never guess)"）。
 */
export function resolveAutoBackendId(repository: string): ManagedWorkspaceBackendId | null {
  if (hasVcsDir(repository, 'jj')) return 'jj-workspace';
  if (hasVcsDir(repository, 'git')) return 'git-worktree';
  return null;
}

/**
 * 解析并探测：显式指定的后端**不可用时返回原因**，绝不回落到别的后端。
 *
 * 契约原文：`Silent fallback to a different backend is a contract violation,
 * because it makes the recorded `backend` field a lie.`
 */
export async function resolveBackend(
  requested: ManagedWorkspaceBackendId | 'auto',
  input: IsolationProbeInput,
): Promise<{ backend: IsolationBackend; probe: IsolationProbeResult } | { error: string }> {
  let id: ManagedWorkspaceBackendId | null;
  if (requested === 'auto') {
    id = resolveAutoBackendId(input.repository);
    if (!id) {
      return { error: `isolation.backend=auto could not resolve: ${input.repository} is neither a jj nor a git repository (refusing to guess)` };
    }
  } else {
    id = requested;
  }
  const backend = ISOLATION_BACKENDS[id];
  if (!backend) {
    return { error: `unknown isolation backend "${id}" (declared: ${declaredBackendIds().join(', ')})` };
  }
  const probe = await backend.probe(input);
  if (!probe.available) {
    // 显式请求的后端不可用 ⇒ fail closed **带原因**；不回落。
    return { error: `isolation backend "${id}" is unavailable: ${probe.reason}` };
  }
  return { backend, probe };
}
