export type ManagedWorkspaceStatus = 'creating' | 'active' | 'backup_ready' | 'released' | 'failed';

export interface ManagedWorkspaceRecord {
  workspaceId: string;
  graphId: string;
  taskId: string;
  projectId: string;
  sourceRoot: string;
  workspaceRoot: string;
  workspaceName: string;
  vcsKind: 'jj';
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
