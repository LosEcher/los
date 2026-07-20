import { createHash } from 'node:crypto';

import { getDb } from '@los/infra/db';

import { ensureRunSpecStore } from '../run-specs.js';
import { ensureSessionEventStore } from '../session-events.js';
import { ensureTaskRunStore } from '../task-runs.js';
import { ensureTodoStore } from '../todos.js';
import type {
  LinkWorkItemRunInput,
  OrphanRuntimeEvidence,
  WorkItemRelationKind,
  WorkItemRunLink,
} from './types.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS work_item_runs (
  id TEXT PRIMARY KEY,
  work_item_id TEXT NOT NULL REFERENCES todos(id) ON DELETE CASCADE,
  run_spec_id TEXT,
  task_run_id TEXT,
  session_id TEXT,
  relation_kind TEXT NOT NULL DEFAULT 'execution',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT work_item_runs_target_chk CHECK (
    run_spec_id IS NOT NULL OR task_run_id IS NOT NULL OR session_id IS NOT NULL
  ),
  CONSTRAINT work_item_runs_relation_chk CHECK (
    relation_kind IN ('discovery', 'planning', 'execution', 'verification', 'recovery', 'closeout')
  )
);
CREATE INDEX IF NOT EXISTS idx_work_item_runs_work_item ON work_item_runs(work_item_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_work_item_runs_run_spec ON work_item_runs(run_spec_id);
CREATE INDEX IF NOT EXISTS idx_work_item_runs_task_run ON work_item_runs(task_run_id);
CREATE INDEX IF NOT EXISTS idx_work_item_runs_session ON work_item_runs(session_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_work_item_runs_unique_run_spec
  ON work_item_runs(work_item_id, run_spec_id) WHERE run_spec_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_work_item_runs_unique_task_run
  ON work_item_runs(work_item_id, task_run_id) WHERE task_run_id IS NOT NULL;
`;

let initialized = false;

export async function ensureWorkItemStore(): Promise<void> {
  if (initialized) return;
  await ensureTodoStore();
  await getDb().exec(SCHEMA);
  initialized = true;
}

export async function linkWorkItemRun(input: LinkWorkItemRunInput): Promise<WorkItemRunLink> {
  await ensureWorkItemStore();
  const targetKey = input.runSpecId
    ? `run:${input.runSpecId}`
    : input.taskRunId
      ? `task:${input.taskRunId}`
      : input.sessionId
        ? `session:${input.sessionId}`
        : undefined;
  if (!targetKey) throw new Error('work item run link requires a run spec, task run, or session id');
  const id = `work-link-${createHash('sha256').update(`${input.workItemId}\0${targetKey}`).digest('hex').slice(0, 24)}`;
  const rows = await getDb().query<WorkItemRunRow>(
    `INSERT INTO work_item_runs (
       id, work_item_id, run_spec_id, task_run_id, session_id, relation_kind
     ) VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (id) DO UPDATE SET
       run_spec_id = COALESCE(EXCLUDED.run_spec_id, work_item_runs.run_spec_id),
       task_run_id = COALESCE(EXCLUDED.task_run_id, work_item_runs.task_run_id),
       session_id = COALESCE(EXCLUDED.session_id, work_item_runs.session_id),
       relation_kind = EXCLUDED.relation_kind,
       updated_at = now()
     RETURNING *`,
    [
      id,
      input.workItemId,
      input.runSpecId ?? null,
      input.taskRunId ?? null,
      input.sessionId ?? null,
      input.relationKind ?? 'execution',
    ],
  );
  return rowToLink(rows.rows[0]!);
}

export async function listWorkItemRunLinks(workItemId: string): Promise<WorkItemRunLink[]> {
  await ensureWorkItemStore();
  const rows = await getDb().query<WorkItemRunRow>(
    'SELECT * FROM work_item_runs WHERE work_item_id = $1 ORDER BY updated_at DESC, id DESC',
    [workItemId],
  );
  return rows.rows.map(rowToLink);
}

/** Return Work Item lineage for a persisted run spec, newest link first. */
export async function listWorkItemRunLinksForRunSpec(runSpecId: string): Promise<WorkItemRunLink[]> {
  await ensureWorkItemStore();
  const rows = await getDb().query<WorkItemRunRow>(
    'SELECT * FROM work_item_runs WHERE run_spec_id = $1 ORDER BY updated_at DESC, id DESC',
    [runSpecId],
  );
  return rows.rows.map(rowToLink);
}

export async function listOrphanRuntimeEvidence(input: {
  projectId?: string;
  limit?: number;
} = {}): Promise<OrphanRuntimeEvidence[]> {
  await Promise.all([
    ensureWorkItemStore(),
    ensureRunSpecStore(),
    ensureTaskRunStore(),
    ensureSessionEventStore(),
  ]);
  const limit = Math.min(100, Math.max(1, input.limit ?? 50));
  const db = getDb();
  const [runs, tasks, events] = await Promise.all([
    db.query<OrphanRow>(
      `SELECT id, session_id, project_id, status, updated_at
       FROM run_specs r
       WHERE r.status IN ('failed', 'blocked')
         AND ($1::text IS NULL OR r.project_id = $1)
         AND NOT EXISTS (
           SELECT 1 FROM work_item_runs w
           WHERE w.run_spec_id = r.id OR (w.run_spec_id IS NULL AND w.session_id = r.session_id)
         )
       ORDER BY updated_at DESC LIMIT $2`,
      [input.projectId ?? null, limit],
    ),
    db.query<OrphanRow>(
      `SELECT id, session_id, project_id, status, updated_at
       FROM task_runs t
       WHERE t.status IN ('failed', 'blocked') AND t.run_spec_id IS NULL
         AND ($1::text IS NULL OR t.project_id = $1)
         AND NOT EXISTS (
           SELECT 1 FROM work_item_runs w WHERE w.task_run_id = t.id OR w.session_id = t.session_id
         )
       ORDER BY updated_at DESC LIMIT $2`,
      [input.projectId ?? null, limit],
    ),
    db.query<OrphanEventRow>(
      `SELECT id, session_id, project_id, type, created_at
       FROM session_events e
       WHERE e.type IN ('operator_attention_required', 'run.operator_attention_required')
         AND ($1::text IS NULL OR e.project_id = $1)
         AND NOT EXISTS (SELECT 1 FROM work_item_runs w WHERE w.session_id = e.session_id)
       ORDER BY created_at DESC LIMIT $2`,
      [input.projectId ?? null, limit],
    ),
  ]);
  return [
    ...runs.rows.map(row => orphanFromRunRow(row, 'orphan_run')),
    ...tasks.rows.map(row => orphanFromRunRow(row, 'orphan_task')),
    ...events.rows.map(row => ({
      id: `event-${row.id}`,
      sourceKind: 'orphan_event' as const,
      title: 'Operator attention requires classification',
      projectId: row.project_id ?? 'los',
      sessionId: row.session_id,
      attentionState: 'unknown' as const,
      updatedAt: toIso(row.created_at),
    })),
  ]
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, limit);
}

type WorkItemRunRow = {
  id: string;
  work_item_id: string;
  run_spec_id: string | null;
  task_run_id: string | null;
  session_id: string | null;
  relation_kind: string;
  created_at: Date | string;
  updated_at: Date | string;
};

type OrphanRow = {
  id: string;
  session_id: string;
  project_id: string | null;
  status: string;
  updated_at: Date | string;
};

type OrphanEventRow = {
  id: number | string;
  session_id: string;
  project_id: string | null;
  type: string;
  created_at: Date | string;
};

function rowToLink(row: WorkItemRunRow): WorkItemRunLink {
  return {
    id: row.id,
    workItemId: row.work_item_id,
    runSpecId: row.run_spec_id ?? undefined,
    taskRunId: row.task_run_id ?? undefined,
    sessionId: row.session_id ?? undefined,
    relationKind: row.relation_kind as WorkItemRelationKind,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

function orphanFromRunRow(
  row: OrphanRow,
  sourceKind: 'orphan_run' | 'orphan_task',
): OrphanRuntimeEvidence {
  return {
    id: `${sourceKind}-${row.id}`,
    sourceKind,
    title: `${sourceKind === 'orphan_run' ? 'Run' : 'Task'} ${row.status} without a Work Item`,
    projectId: row.project_id ?? 'los',
    sessionId: row.session_id,
    runSpecId: sourceKind === 'orphan_run' ? row.id : undefined,
    taskRunId: sourceKind === 'orphan_task' ? row.id : undefined,
    attentionState: 'recovery_required',
    updatedAt: toIso(row.updated_at),
  };
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
