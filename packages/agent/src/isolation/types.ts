/**
 * isolation/types.ts — 隔离后端的公共类型（ADR 0047 §5.1 / contracts/isolation-backend.yaml）。
 *
 * 三条接口纪律是**契约条款**，不得放宽：
 *   1. 后端**只返回原始结果**（`exitCode`/`stdout`/`stderr`/`durationMs`），
 *      **绝不返回 PASS/FAIL** —— 判定与三态分类属门禁层。把"判不了"压成"失败"
 *      正是 2026-10-08 假红事故的机制。
 *   2. 后端**不得写 los 账本**（单写者 R1）。
 *   3. `probe()` 必须能回答**为什么**不可用 —— 否则"不可用"无从表达，只能静默回落。
 *
 * 本文件即纪律 1 与 2 的体现：导出的类型里**没有** verdict 字段，且不做任何落账。
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { ManagedWorkspaceBackendId } from '../managed-workspace-types.js';

const execFileAsync = promisify(execFile);

/** 探测结果：`available: false` 时 `reason` **必填**（联合类型 ⇒ 编译期要求）。 */
export type IsolationProbeResult =
  | { available: true; detail: Record<string, unknown> }
  | { available: false; reason: string; detail?: Record<string, unknown> };

export interface IsolationProbeInput {
  /** 被隔离的仓根（工作树来源）。 */
  repository: string;
}

/**
 * 原始执行结果。**没有 verdict 字段**（纪律 1）。
 *
 * `exitCode: null` 表示**命令未曾运行**（例如变更集为空被拒、spawn 失败、超时），
 * 这与 `exitCode: 0`（跑过且成功）**是两件事**，必须区分，否则"没跑"会被读成"通过"。
 */
export interface RawExecutionResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  /** 观测到的原始事实（不是判定）。用于排障与审计。 */
  observed?: Record<string, unknown>;
}

export interface IsolationCreateInput {
  repository: string;
  /** 隔离资源的目标路径。 */
  path: string;
  /** 隔离资源的名字（VCS 侧的标识）。 */
  name: string;
  /** 从哪个修订派生（VCS 语义）。 */
  baseRevision: string;
  /** 人类可读的用途说明（写进 VCS 记录）。 */
  label: string;
}

export interface IsolationRunInput {
  repository: string;
  /** 隔离资源的路径（命令在此执行）。 */
  path: string;
  /** 要执行的验证命令（shell 原文）。 */
  command: string;
  timeoutMs: number;
}

export interface IsolationReleaseInput {
  repository: string;
  path: string;
  name: string;
  backendState: Record<string, unknown>;
}

/**
 * 后端接口。**注意返回类型里没有任何 verdict 字段** —— 见文件头纪律 1。
 *
 * `detectPollution` 可选：能回答"隔离资源是否被污染"的后端提供它；外部工具
 * （sandbox-run）自带污染检测，内建后端可返回 null 表示"未检测"（**不是"没污染"**）。
 */
export interface IsolationBackend {
  readonly id: ManagedWorkspaceBackendId;
  probe(input: IsolationProbeInput): Promise<IsolationProbeResult>;
  create(input: IsolationCreateInput): Promise<{ path: string; backendState: Record<string, unknown> }>;
  execute(input: IsolationRunInput): Promise<RawExecutionResult>;
  /**
   * 捕获隔离资源相对基线的补丁（git 格式）。
   *
   * 为什么属于后端而不是调用方：**补丁形态是各 VCS 自己的事**
   * （jj 是 `jj diff --git`，git 是 `git diff`）。调用方硬编码其中一种，
   * 就等于把"多后端"变成摆设 —— 这正是 C2 接线时暴露出来的第三处泄漏。
   *
   * 返回原文补丁（可能为空字符串 = 无改动）。**不判定**"该不该提交"。
   */
  capturePatch(input: { repository: string; path: string }): Promise<string>;
  detectPollution?(input: { repository: string; path: string }):
    Promise<{ polluted: boolean; detail?: string } | null>;
  release(input: IsolationReleaseInput): Promise<void>;
}

/** 在 PATH 上找一个可执行文件。 */
export async function which(bin: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('/usr/bin/which', [bin], { timeout: 5_000 });
    const p = stdout.trim();
    return p.length > 0 ? p : null;
  } catch {
    return null;
  }
}

/** 仓内是否存在某个 VCS 元目录。 */
export function hasVcsDir(repository: string, kind: 'jj' | 'git'): boolean {
  return existsSync(join(repository, kind === 'jj' ? '.jj' : '.git'));
}

/**
 * 跑一条 VCS 命令并返回**原始结果**（不判定）。
 *
 * 本助手被内建后端共用。它把"spawn 失败"与"命令非零退出"分开：
 * 前者 `exitCode: null`（环境故障），后者是**真实结果**。
 */
export async function runRaw(
  bin: string,
  args: string[],
  opts: { cwd: string; timeoutMs: number },
): Promise<RawExecutionResult> {
  const started = Date.now();
  return await new Promise<RawExecutionResult>((resolve) => {
    execFile(bin, args, { cwd: opts.cwd, timeout: opts.timeoutMs, maxBuffer: 8 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const durationMs = Date.now() - started;
        const so = String(stdout ?? '');
        const se = String(stderr ?? '');
        if (!error) return resolve({ exitCode: 0, stdout: so, stderr: se, durationMs });
        // execFile 的 error 带 code；非数字（spawn 失败/超时）⇒ 环境故障
        const code = (error as NodeJS.ErrnoException & { code?: number | string }).code;
        if (typeof code === 'number') {
          return resolve({ exitCode: code, stdout: so, stderr: se, durationMs });
        }
        resolve({
          exitCode: null, stdout: so, stderr: `${se}\n${error.message}`, durationMs,
          observed: { spawnError: String(code ?? error.message), killed: (error as { killed?: boolean }).killed ?? false },
        });
      });
  });
}
