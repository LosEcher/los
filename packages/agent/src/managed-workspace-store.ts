import { randomUUID } from 'node:crypto';
import { getDb } from '@los/infra/db';
import type {
  ListManagedWorkspacesOptions,
  ManagedWorkspaceDetail,
  ManagedWorkspaceEvent,
  ManagedWorkspaceRecord,
  ManagedWorkspaceStatus,
} from './managed-workspace-types.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS managed_workspaces (
  workspace_id TEXT PRIMARY KEY,
  graph_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  source_root TEXT NOT NULL,
  workspace_root TEXT NOT NULL UNIQUE,
  workspace_name TEXT NOT NULL UNIQUE,
  vcs_kind TEXT NOT NULL DEFAULT 'jj',
  base_revision TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'creating',
  backup_artifact_id TEXT,
  created_by TEXT NOT NULL,
  last_error TEXT,
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  released_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_managed_workspaces_graph ON managed_workspaces(graph_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_managed_workspaces_task ON managed_workspaces(task_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_managed_workspaces_project ON managed_workspaces(project_id, created_at DESC);
CREATE TABLE IF NOT EXISTS managed_workspace_events (
  event_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  actor TEXT NOT NULL,
  artifact_id TEXT,
  payload_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_managed_workspace_events_workspace
  ON managed_workspace_events(workspace_id, created_at ASC);
`;

type WorkspaceRow = {
  workspace_id: string; graph_id: string; task_id: string; project_id: string;
  source_root: string; workspace_root: string; workspace_name: string; vcs_kind: 'jj';
  base_revision: string; status: ManagedWorkspaceStatus; backup_artifact_id: string | null;
  created_by: string; last_error: string | null; metadata_json: unknown;
  created_at: Date | string; updated_at: Date | string; released_at: Date | string | null;
};

type EventRow = {
  event_id: string; workspace_id: string; event_type: string; actor: string;
  artifact_id: string | null; payload_json: unknown; created_at: Date | string;
};

let _initialized = false;

export async function ensureManagedWorkspaceStore(): Promise<void> {
  if (_initialized) return;
  await getDb().exec(SCHEMA);
  _initialized = true;
}

export async function insertManagedWorkspace(input: Omit<ManagedWorkspaceRecord, 'createdAt' | 'updatedAt' | 'releasedAt'>): Promise<ManagedWorkspaceRecord> {
  await ensureManagedWorkspaceStore();
  const rows = await getDb().query<WorkspaceRow>(`
    INSERT INTO managed_workspaces (
      workspace_id, graph_id, task_id, project_id, source_root, workspace_root,
      workspace_name, vcs_kind, base_revision, status, backup_artifact_id,
      created_by, last_error, metadata_json
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,'jj',$8,$9,$10,$11,$12,$13::jsonb)
    RETURNING *
  `, [
    input.workspaceId, input.graphId, input.taskId, input.projectId, input.sourceRoot,
    input.workspaceRoot, input.workspaceName, input.baseRevision, input.status,
    input.backupArtifactId ?? null, input.createdBy, input.lastError ?? null,
    JSON.stringify(input.metadata),
  ]);
  return rowToWorkspace(required(rows.rows[0]));
}

export async function updateManagedWorkspace(
  workspaceId: string,
  update: { status: ManagedWorkspaceStatus; backupArtifactId?: string; lastError?: string; released?: boolean },
): Promise<ManagedWorkspaceRecord> {
  await ensureManagedWorkspaceStore();
  const rows = await getDb().query<WorkspaceRow>(`
    UPDATE managed_workspaces
    SET status = $2,
        backup_artifact_id = COALESCE($3, backup_artifact_id),
        last_error = $4,
        released_at = CASE WHEN $5 THEN now() ELSE released_at END,
        updated_at = now()
    WHERE workspace_id = $1
    RETURNING *
  `, [workspaceId, update.status, update.backupArtifactId ?? null, update.lastError ?? null, update.released === true]);
  return rowToWorkspace(required(rows.rows[0]));
}

export async function loadManagedWorkspace(workspaceId: string): Promise<ManagedWorkspaceRecord | null> {
  await ensureManagedWorkspaceStore();
  const rows = await getDb().query<WorkspaceRow>('SELECT * FROM managed_workspaces WHERE workspace_id = $1', [workspaceId]);
  return rows.rows[0] ? rowToWorkspace(rows.rows[0]) : null;
}

export async function loadManagedWorkspaceDetail(workspaceId: string): Promise<ManagedWorkspaceDetail | null> {
  const workspace = await loadManagedWorkspace(workspaceId);
  if (!workspace) return null;
  return { workspace, events: await listManagedWorkspaceEvents(workspaceId) };
}

export async function listManagedWorkspaces(options: ListManagedWorkspacesOptions = {}): Promise<ManagedWorkspaceRecord[]> {
  await ensureManagedWorkspaceStore();
  const limit = Math.max(1, Math.min(200, Math.floor(options.limit ?? 100)));
  const rows = await getDb().query<WorkspaceRow>(`
    SELECT * FROM managed_workspaces
    WHERE ($2::text IS NULL OR graph_id = $2)
      AND ($3::text IS NULL OR task_id = $3)
      AND ($4::text IS NULL OR project_id = $4)
      AND ($5::text IS NULL OR status = $5)
    ORDER BY created_at DESC
    LIMIT $1
  `, [limit, optional(options.graphId), optional(options.taskId), optional(options.projectId), options.status ?? null]);
  return rows.rows.map(rowToWorkspace);
}

export async function listManagedWorkspacesForRunSpec(runSpecId: string): Promise<ManagedWorkspaceRecord[]> {
  await ensureManagedWorkspaceStore();
  const rows = await getDb().query<WorkspaceRow>(`
    SELECT workspace.*
    FROM managed_workspaces workspace
    JOIN agent_tasks task ON task.id = workspace.task_id
    WHERE task.run_spec_id = $1
    ORDER BY workspace.created_at DESC, workspace.workspace_id ASC
  `, [runSpecId]);
  return rows.rows.map(rowToWorkspace);
}

export async function appendManagedWorkspaceEvent(input: {
  workspaceId: string; eventType: string; actor: string; artifactId?: string;
  payload?: Record<string, unknown>;
}): Promise<ManagedWorkspaceEvent> {
  await ensureManagedWorkspaceStore();
  const rows = await getDb().query<EventRow>(`
    INSERT INTO managed_workspace_events (event_id, workspace_id, event_type, actor, artifact_id, payload_json)
    VALUES ($1,$2,$3,$4,$5,$6::jsonb)
    RETURNING *
  `, [
    `workspace-event-${randomUUID()}`, input.workspaceId, input.eventType,
    input.actor, input.artifactId ?? null, JSON.stringify(input.payload ?? {}),
  ]);
  return rowToEvent(required(rows.rows[0]));
}

async function listManagedWorkspaceEvents(workspaceId: string): Promise<ManagedWorkspaceEvent[]> {
  await ensureManagedWorkspaceStore();
  const rows = await getDb().query<EventRow>(
    'SELECT * FROM managed_workspace_events WHERE workspace_id = $1 ORDER BY created_at ASC, event_id ASC',
    [workspaceId],
  );
  return rows.rows.map(rowToEvent);
}

export async function assignManagedWorkspaceToTask(record: ManagedWorkspaceRecord): Promise<void> {
  const result = await getDb().query<{ id: string }>(`
    UPDATE agent_tasks
    SET metadata_json = metadata_json || $2::jsonb, updated_at = now()
    WHERE id = $1 AND graph_id = $3 AND role = 'executor' AND status = 'queued'
    RETURNING id
  `, [record.taskId, JSON.stringify({
    managedWorkspaceId: record.workspaceId,
    workspaceRoot: record.workspaceRoot,
    sourceWorkspaceRoot: record.sourceRoot,
    workspaceVcs: record.vcsKind,
  }), record.graphId]);
  if (result.rows.length !== 1) throw new Error('task is not a queued executor in the requested graph');
}

export async function clearManagedWorkspaceFromTask(record: ManagedWorkspaceRecord): Promise<void> {
  await getDb().query(`
    UPDATE agent_tasks
    SET metadata_json = metadata_json - 'managedWorkspaceId' - 'workspaceRoot' - 'sourceWorkspaceRoot' - 'workspaceVcs',
        updated_at = now()
    WHERE id = $1 AND metadata_json->>'managedWorkspaceId' = $2
  `, [record.taskId, record.workspaceId]);
}

function rowToWorkspace(row: WorkspaceRow): ManagedWorkspaceRecord {
  return {
    workspaceId: row.workspace_id, graphId: row.graph_id, taskId: row.task_id,
    projectId: row.project_id, sourceRoot: row.source_root, workspaceRoot: row.workspace_root,
    workspaceName: row.workspace_name, vcsKind: row.vcs_kind, baseRevision: row.base_revision,
    status: row.status, backupArtifactId: row.backup_artifact_id ?? undefined,
    createdBy: row.created_by, lastError: row.last_error ?? undefined,
    metadata: record(row.metadata_json), createdAt: iso(row.created_at), updatedAt: iso(row.updated_at),
    releasedAt: row.released_at ? iso(row.released_at) : undefined,
  };
}

function rowToEvent(row: EventRow): ManagedWorkspaceEvent {
  return {
    eventId: row.event_id, workspaceId: row.workspace_id, eventType: row.event_type,
    actor: row.actor, artifactId: row.artifact_id ?? undefined, payload: record(row.payload_json),
    createdAt: iso(row.created_at),
  };
}

function optional(value: string | undefined): string | null { return value?.trim() || null; }
function iso(value: Date | string): string { return value instanceof Date ? value.toISOString() : new Date(value).toISOString(); }
function record(value: unknown): Record<string, unknown> { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function required<T>(value: T | undefined): T { if (!value) throw new Error('managed workspace row missing'); return value; }
