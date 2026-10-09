/**
 * isolation/jj-workspace.ts — 内建 jj 隔离后端。
 *
 * 契约要求（contracts/isolation-backend.yaml）：内建后端是**纯命令编排**，
 * **除 VCS 本身外不得依赖外部二进制**。本文件只调 `jj`。
 *
 * 行为对齐既有实现（`managed-workspaces.ts` 里原先内联的 `jj workspace add`），
 * 只是把它从"唯一路径"变成"可替换后端之一"。
 */
import { rm } from 'node:fs/promises';
import type {
  IsolationBackend, IsolationCreateInput, IsolationReleaseInput,
  IsolationRunInput, RawExecutionResult,
} from './types.js';
import { hasVcsDir, runRaw, which } from './types.js';

const JJ_TIMEOUT_MS = 120_000;

/** 解析 jj 二进制的绝对路径（避免路径歧义）。 */
async function jjBin(): Promise<string | null> {
  return await which('jj');
}

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
    const bin = await jjBin();
    if (!bin) {
      return {
        available: false,
        reason: 'jj binary not found on PATH — the built-in jj backend needs only the VCS itself',
        detail: { repository },
      };
    }
    return { available: true, detail: { repository, binary: bin } };
  },

  async create(input: IsolationCreateInput) {
    const bin = await jjBin();
    if (!bin) throw new Error('jj binary not found on PATH');
    // `jj workspace add --name <n> -r <rev> -m <msg> <path>`
    const res = await runRaw(bin, [
      'workspace', 'add', '--name', input.name, '-r', input.baseRevision,
      '-m', input.label, input.path,
    ], { cwd: input.repository, timeoutMs: JJ_TIMEOUT_MS });
    if (res.exitCode !== 0) {
      // 原始结果里已有 stderr；这里**只负责报告**，不判定"是环境问题还是逻辑问题"
      throw new Error(`jj workspace add failed (exit ${String(res.exitCode)}): ${res.stderr.trim() || res.stdout.trim()}`);
    }
    return { path: input.path, backendState: { vcs: 'jj', workspaceName: input.name, baseRevision: input.baseRevision } };
  },

  async execute(input: IsolationRunInput): Promise<RawExecutionResult> {
    // 在隔离工作区里跑命令。用 /bin/sh -c 以支持 shell 原文（与委托路径一致）。
    return await runRaw('/bin/sh', ['-c', input.command], {
      cwd: input.path, timeoutMs: input.timeoutMs,
    });
  },

  async capturePatch({ repository, path }) {
    const bin = await jjBin();
    if (!bin) throw new Error('jj binary not found on PATH');
    const res = await runRaw(bin, ['--no-pager', '--color', 'never', '-R', path, 'diff', '--git'], {
      cwd: repository, timeoutMs: JJ_TIMEOUT_MS,
    });
    if (res.exitCode !== 0) {
      throw new Error(`jj diff failed (exit ${String(res.exitCode)}): ${res.stderr.trim() || res.stdout.trim()}`);
    }
    return res.stdout;
  },

  async detectPollution({ repository, path }) {
    const bin = await jjBin();
    if (!bin) return null;
    // `jj diff --stat` 在隔离工作区里有输出 ⇒ 有未提交改动（可能被污染）。
    // 返回**事实**，不判定污染是否可接受。
    const res = await runRaw(bin, ['--no-pager', '--color', 'never', '-R', path, 'diff', '--stat'], {
      cwd: repository, timeoutMs: JJ_TIMEOUT_MS,
    });
    if (res.exitCode !== 0) return null;   // 查不了 ⇒ 未检测（**不是**没污染）
    const dirty = res.stdout.trim().length > 0;
    return { polluted: dirty, detail: dirty ? res.stdout.trim().slice(0, 500) : undefined };
  },

  async release(input: IsolationReleaseInput) {
    const bin = await jjBin();
    if (!bin) throw new Error('jj binary not found on PATH');
    // `jj workspace forget <name>` 解除登记；目录本身由 los 账本负责清理。
    const res = await runRaw(bin, ['workspace', 'forget', input.name], {
      cwd: input.repository, timeoutMs: JJ_TIMEOUT_MS,
    });
    if (res.exitCode !== 0) {
      throw new Error(`jj workspace forget failed (exit ${String(res.exitCode)}): ${res.stderr.trim() || res.stdout.trim()}`);
    }
    // `workspace forget` 只解除登记，**目录仍在** ⇒ 由本后端负责移除。
    // （对照 git：`git worktree remove` 自己会删目录。）
    await rm(input.path, { recursive: true, force: false });
  },
};
