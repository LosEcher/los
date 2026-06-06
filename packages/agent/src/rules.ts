/**
 * @los/agent/rules — Persistent rule registry.
 *
 * Stores policy rules (scope, severity, enforcement) in PostgreSQL.
 */
import { getDb } from '@los/infra/db';

// ── Types ────────────────────────────────────────────────

export type RuleScope = 'global' | 'project' | 'user';
export type RuleSeverity = 'info' | 'warn' | 'error' | 'block';
export type RuleEnforcementMode = 'advisory' | 'required';
export type RuleStatus = 'active' | 'inactive' | 'draft';

export interface RuleRecord {
  name: string;
  scope: RuleScope;
  severity: RuleSeverity;
  enforcementMode: RuleEnforcementMode;
  status: RuleStatus;
  content: string;
  lastChanged?: string;
  attachedSessions: string[];
  attachedTasks: string[];
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface UpsertRuleInput {
  name: string;
  scope?: RuleScope;
  severity?: RuleSeverity;
  enforcementMode?: RuleEnforcementMode;
  status?: RuleStatus;
  content?: string;
  attachedSessions?: string[];
  attachedTasks?: string[];
  metadata?: Record<string, unknown>;
}

interface RuleRow {
  name: string;
  scope: string;
  severity: string;
  enforcement_mode: string;
  status: string;
  content: string;
  last_changed: string | null;
  attached_sessions_json: string;
  attached_tasks_json: string;
  metadata_json: string;
  created_at: string;
  updated_at: string;
}

// ── Schema ────────────────────────────────────────────────

const SCHEMA = `
CREATE TABLE IF NOT EXISTS rules (
  name TEXT PRIMARY KEY,
  scope TEXT NOT NULL DEFAULT 'project',
  severity TEXT NOT NULL DEFAULT 'warn',
  enforcement_mode TEXT NOT NULL DEFAULT 'advisory',
  status TEXT NOT NULL DEFAULT 'active',
  content TEXT NOT NULL DEFAULT '',
  last_changed TIMESTAMPTZ,
  attached_sessions_json JSONB NOT NULL DEFAULT '[]',
  attached_tasks_json JSONB NOT NULL DEFAULT '[]',
  metadata_json JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_rules_scope ON rules(scope);
CREATE INDEX IF NOT EXISTS idx_rules_status ON rules(status);
CREATE INDEX IF NOT EXISTS idx_rules_severity ON rules(severity);
`;

let _initialized = false;

export async function ensureRuleStore(): Promise<void> {
  if (_initialized) return;
  const db = getDb();
  await db.exec(SCHEMA);
  _initialized = true;
}

// ── CRUD ─────────────────────────────────────────────────

export async function upsertRule(input: UpsertRuleInput): Promise<RuleRecord> {
  await ensureRuleStore();
  const db = getDb();
  const rows = await db.query<RuleRow>(
    `INSERT INTO rules (name, scope, severity, enforcement_mode, status, content, attached_sessions_json, attached_tasks_json, metadata_json, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9::jsonb, now())
     ON CONFLICT (name) DO UPDATE SET
       scope = EXCLUDED.scope,
       severity = EXCLUDED.severity,
       enforcement_mode = EXCLUDED.enforcement_mode,
       status = EXCLUDED.status,
       content = EXCLUDED.content,
       attached_sessions_json = EXCLUDED.attached_sessions_json,
       attached_tasks_json = EXCLUDED.attached_tasks_json,
       metadata_json = EXCLUDED.metadata_json,
       last_changed = now(),
       updated_at = now()
     RETURNING *`,
    [
      input.name,
      input.scope ?? 'project',
      input.severity ?? 'warn',
      input.enforcementMode ?? 'advisory',
      input.status ?? 'active',
      input.content ?? '',
      JSON.stringify(input.attachedSessions ?? []),
      JSON.stringify(input.attachedTasks ?? []),
      JSON.stringify(input.metadata ?? {}),
    ],
  );
  return rowToRecord(assertRow(rows.rows[0]));
}

export async function loadRule(name: string): Promise<RuleRecord | null> {
  await ensureRuleStore();
  const db = getDb();
  const rows = await db.query<RuleRow>('SELECT * FROM rules WHERE name = $1', [name]);
  if (rows.rows.length === 0) return null;
  return rowToRecord(rows.rows[0]);
}

export async function listRules(options: {
  scope?: RuleScope;
  status?: RuleStatus;
  severity?: RuleSeverity;
} = {}): Promise<RuleRecord[]> {
  await ensureRuleStore();
  const db = getDb();
  const clauses: string[] = [];
  const params: unknown[] = [];
  let idx = 1;

  if (options.scope) {
    clauses.push(`scope = $${idx++}`);
    params.push(options.scope);
  }
  if (options.status) {
    clauses.push(`status = $${idx++}`);
    params.push(options.status);
  }
  if (options.severity) {
    clauses.push(`severity = $${idx++}`);
    params.push(options.severity);
  }

  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  const rows = await db.query<RuleRow>(
    `SELECT * FROM rules ${where} ORDER BY severity ASC, updated_at DESC`,
    params,
  );
  return rows.rows.map(rowToRecord);
}

export async function updateRuleStatus(
  name: string,
  status: RuleStatus,
): Promise<RuleRecord | null> {
  await ensureRuleStore();
  const db = getDb();
  const rows = await db.query<RuleRow>(
    `UPDATE rules SET status = $2, last_changed = now(), updated_at = now() WHERE name = $1 RETURNING *`,
    [name, status],
  );
  if (rows.rows.length === 0) return null;
  return rowToRecord(rows.rows[0]);
}

export async function deleteRule(name: string): Promise<boolean> {
  await ensureRuleStore();
  const db = getDb();
  const rows = await db.query('DELETE FROM rules WHERE name = $1 RETURNING name', [name]);
  return rows.rows.length > 0;
}

// ── Helpers ───────────────────────────────────────────────

function rowToRecord(row: RuleRow): RuleRecord {
  let attachedSessions: string[] = [];
  try { attachedSessions = JSON.parse(row.attached_sessions_json); } catch {}
  let attachedTasks: string[] = [];
  try { attachedTasks = JSON.parse(row.attached_tasks_json); } catch {}
  let metadata: Record<string, unknown> = {};
  try { metadata = JSON.parse(row.metadata_json); } catch {}

  return {
    name: row.name,
    scope: row.scope as RuleScope,
    severity: row.severity as RuleSeverity,
    enforcementMode: row.enforcement_mode as RuleEnforcementMode,
    status: row.status as RuleStatus,
    content: row.content,
    lastChanged: row.last_changed ?? undefined,
    attachedSessions,
    attachedTasks,
    metadata,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function assertRow<T>(row: T | undefined): T {
  if (!row) throw new Error('upsert returned no row');
  return row;
}
