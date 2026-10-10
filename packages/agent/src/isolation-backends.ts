/**
 * isolation-backends.ts — 隔离后端的**注册表与解析**（ADR 0047 §5.1）。
 *
 * 契约：`contracts/isolation-backend.yaml`。三条接口纪律见 `./isolation/types.ts`。
 *
 * 本文件只做三件事（实现已按后端拆到 `./isolation/`，以守住 500 行模块门禁）：
 *   1. **注册表** `ISOLATION_BACKENDS`：los 拥有这张表（账本职责），backend 不注册自己
 *   2. **解析** `resolveAutoBackendId` / `resolveBackend`：把配置值变成具体后端，
 *      并**在不可用时带原因地拒绝**（禁止静默回落）
 *   3. 再导出，使 `./isolation-backends.js` 保持为稳定入口
 *
 * 为什么注册表在这里而不是各后端文件里：让"有哪些后端"有一处可读的清单，
 * 配置校验与错误信息都从它派生。
 */
import type { ManagedWorkspaceBackendId } from './managed-workspace-types.js';
import type { IsolationBackend, IsolationProbeInput, IsolationProbeResult } from './isolation/types.js';
import { hasVcsDir } from './isolation/types.js';
import { jjWorkspaceBackend } from './isolation/jj-workspace.js';
import { gitWorktreeBackend } from './isolation/git-worktree.js';
import { dockerBackend } from './isolation/docker.js';

// ── 对外再导出：保持 `./isolation-backends.js` 作为稳定入口 ──
export type {
  IsolationBackend,
  IsolationProbeInput,
  IsolationProbeResult,
  IsolationCreateInput,
  IsolationRunInput,
  IsolationReleaseInput,
  RawExecutionResult,
} from './isolation/types.js';
export { which, hasVcsDir, runRaw } from './isolation/types.js';
export { jjWorkspaceBackend } from './isolation/jj-workspace.js';
export { gitWorktreeBackend } from './isolation/git-worktree.js';
export { dockerBackend } from './isolation/docker.js';
export { parseSandboxRunReport, executeViaSandboxRun } from './isolation/sandbox-run.js';

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
 * because it makes the recorded backend field a lie.`
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
