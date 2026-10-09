/**
 * isolation/git-worktree.ts — 内建 git 隔离后端。
 *
 * 与 jj 后端同构：**纯命令编排，除 git 本身外不依赖外部二进制**。
 * git 没有"命名工作区"的概念，故用 `git worktree add` + 分支/分离 HEAD。
 */
import type {
  IsolationBackend, IsolationCreateInput, IsolationReleaseInput,
  IsolationRunInput, RawExecutionResult,
} from './types.js';
import { hasVcsDir, runRaw, which } from './types.js';

const GIT_TIMEOUT_MS = 120_000;

async function gitBin(): Promise<string | null> {
  return await which('git');
}

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
    const bin = await gitBin();
    if (!bin) {
      return {
        available: false,
        reason: 'git binary not found on PATH — the built-in git-worktree backend needs only the VCS itself',
        detail: { repository },
      };
    }
    return { available: true, detail: { repository, binary: bin } };
  },

  async create(input: IsolationCreateInput) {
    const bin = await gitBin();
    if (!bin) throw new Error('git binary not found on PATH');
    // 分离 HEAD 建 worktree：不创建分支、不动原仓的分支命名空间。
    const res = await runRaw(bin, ['worktree', 'add', '--detach', input.path, input.baseRevision], {
      cwd: input.repository, timeoutMs: GIT_TIMEOUT_MS,
    });
    if (res.exitCode !== 0) {
      throw new Error(`git worktree add failed (exit ${String(res.exitCode)}): ${res.stderr.trim() || res.stdout.trim()}`);
    }
    return { path: input.path, backendState: { vcs: 'git', worktree: input.path, baseRevision: input.baseRevision, detached: true } };
  },

  async execute(input: IsolationRunInput): Promise<RawExecutionResult> {
    return await runRaw('/bin/sh', ['-c', input.command], {
      cwd: input.path, timeoutMs: input.timeoutMs,
    });
  },

  async capturePatch({ repository, path }) {
    const bin = await gitBin();
    if (!bin) throw new Error('git binary not found on PATH');
    // 未跟踪文件不在 `git diff` 里，先 `add -N`（intent-to-add）让它们出现在补丁中，
    // 否则"备份"会漏掉新增文件 —— 那是会丢工作的漏。
    await runRaw(bin, ['add', '-N', '.'], { cwd: path, timeoutMs: GIT_TIMEOUT_MS });
    const res = await runRaw(bin, ['diff', '--binary'], { cwd: path, timeoutMs: GIT_TIMEOUT_MS });
    if (res.exitCode !== 0) {
      throw new Error(`git diff failed (exit ${String(res.exitCode)}): ${res.stderr.trim() || res.stdout.trim()}`);
    }
    void repository;
    return res.stdout;
  },

  async detectPollution({ repository, path }) {
    const bin = await gitBin();
    if (!bin) return null;
    // `git status --porcelain` 有输出 ⇒ 工作树脏（可能被污染）。返回事实，不判定。
    const res = await runRaw(bin, ['status', '--porcelain'], { cwd: path, timeoutMs: GIT_TIMEOUT_MS });
    if (res.exitCode !== 0) return null;   // 查不了 ⇒ 未检测（**不是**没污染）
    const dirty = res.stdout.trim().length > 0;
    return { polluted: dirty, detail: dirty ? res.stdout.trim().slice(0, 500) : undefined };
  },

  async release(input: IsolationReleaseInput) {
    const bin = await gitBin();
    if (!bin) throw new Error('git binary not found on PATH');
    const res = await runRaw(bin, ['worktree', 'remove', '--force', input.path], {
      cwd: input.repository, timeoutMs: GIT_TIMEOUT_MS,
    });
    if (res.exitCode !== 0) {
      throw new Error(`git worktree remove failed (exit ${String(res.exitCode)}): ${res.stderr.trim() || res.stdout.trim()}`);
    }
    // `git worktree remove` **已连同目录一起删除**；调用方不得再 rm 一次
    // （否则 ENOENT 会被误记成 release_failed —— 2026-10-08 实测踩到）。
  },
};
