/**
 * 已声明的隔离后端。内建 `jj-workspace` / `git-worktree` 是纯命令编排
 * （除 VCS 本身外**不得**依赖外部二进制）；`docker` 委托 `sandbox-run`。
 */
export type ManagedWorkspaceBackendId = 'jj-workspace' | 'git-worktree' | 'docker';

export const MANAGED_WORKSPACE_BACKENDS: readonly ManagedWorkspaceBackendId[] =
  ['jj-workspace', 'git-worktree', 'docker'] as const;

export type ManagedWorkspaceStatus = 'creating' | 'active' | 'backup_ready' | 'released' | 'failed';

export interface ManagedWorkspaceRecord {
  workspaceId: string;
  graphId: string;
  taskId: string;
  projectId: string;
  sourceRoot: string;
  workspaceRoot: string;
  workspaceName: string;
  /**
   * Isolation backend id（ADR 0047 §5.1）。`vcsKind: 'jj'` 曾把"哪个 VCS"
   * 与"怎么隔离"混为一谈；现在它是可扩展的 backend id，内建 jj 后端名为
   * `jj-workspace`。见 contracts/isolation-backend.yaml。
   *
   * **los 拥有此字段**（账本职责）；backend 自身**不得**写它。
   */
  backend: ManagedWorkspaceBackendId;
  baseRevision: string;
  status: ManagedWorkspaceStatus;
  backupArtifactId?: string;
  createdBy: string;
  lastError?: string;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  releasedAt?: string;
}

export interface ManagedWorkspaceEvent {
  eventId: string;
  workspaceId: string;
  eventType: string;
  actor: string;
  artifactId?: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface ManagedWorkspaceDetail {
  workspace: ManagedWorkspaceRecord;
  events: ManagedWorkspaceEvent[];
}

export interface CreateManagedWorkspaceInput {
  workspaceId: string;
  graphId: string;
  taskId: string;
  projectId: string;
  sourceRoot: string;
  createdBy: string;
  /**
   * 隔离后端。缺省 `jj-workspace`（历史行为：本表只服务 jj 仓）。
   *
   * **C2 会把它变成真正的选择面**（按仓自动解析 + 显式指定 fail-closed）；
   * C1 只做"从硬编码改为显式字段"，不改变既有行为。
   */
  backend?: ManagedWorkspaceBackendId;
  metadata?: Record<string, unknown>;
}

export interface ListManagedWorkspacesOptions {
  graphId?: string;
  taskId?: string;
  projectId?: string;
  status?: ManagedWorkspaceStatus;
  limit?: number;
}

export interface ManagedWorkspaceRuntimeOptions {
  artifactStorageRoot: string;
  nodeId?: string;
  requestId?: string;
  traceId?: string;
}
