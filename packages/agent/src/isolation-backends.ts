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
import { execFile } from 'node:child_process';
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
