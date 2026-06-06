/**
 * @los/agent/skills — Persistent skill registry.
 *
 * Stores reusable agent instruction bundles (skills) in PostgreSQL.
 */
import { getDb } from '@los/infra/db';

// ── Types ────────────────────────────────────────────────

export type SkillRunMode = 'auto' | 'manual';

export interface SkillRecord {
  name: string;
  category: string;
  description: string;
  runMode: SkillRunMode;
  sourcePath: string;
  versionHash: string;
  usageCount: number;
  lastUsed?: string;
  enabled: boolean;
  content: string;
  tags: string[];
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface UpsertSkillInput {
  name: string;
  category?: string;
  description?: string;
  runMode?: SkillRunMode;
  sourcePath?: string;
  versionHash?: string;
  enabled?: boolean;
  content?: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
}

interface SkillRow {
  name: string;
  category: string;
  description: string;
  run_mode: string;
  source_path: string;
  version_hash: string;
  usage_count: number;
  last_used: string | null;
  enabled: boolean;
  content: string;
  tags_json: string;
  metadata_json: string;
  created_at: string;
  updated_at: string;
}

// ── Schema ────────────────────────────────────────────────

const SCHEMA = `
CREATE TABLE IF NOT EXISTS skills (
  name TEXT PRIMARY KEY,
  category TEXT NOT NULL DEFAULT 'general',
  description TEXT NOT NULL DEFAULT '',
  run_mode TEXT NOT NULL DEFAULT 'manual',
  source_path TEXT NOT NULL DEFAULT '',
  version_hash TEXT NOT NULL DEFAULT '',
  usage_count INTEGER NOT NULL DEFAULT 0,
  last_used TIMESTAMPTZ,
  enabled BOOLEAN NOT NULL DEFAULT true,
  content TEXT NOT NULL DEFAULT '',
  tags_json JSONB NOT NULL DEFAULT '[]',
  metadata_json JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_skills_category ON skills(category);
CREATE INDEX IF NOT EXISTS idx_skills_enabled ON skills(enabled);
`;

let _initialized = false;

export async function ensureSkillStore(): Promise<void> {
  if (_initialized) return;
  const db = getDb();
  await db.exec(SCHEMA);
  _initialized = true;
}

// ── CRUD ─────────────────────────────────────────────────

export async function upsertSkill(input: UpsertSkillInput): Promise<SkillRecord> {
  await ensureSkillStore();
  const db = getDb();
  const rows = await db.query<SkillRow>(
    `INSERT INTO skills (name, category, description, run_mode, source_path, version_hash, enabled, content, tags_json, metadata_json, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb, now())
     ON CONFLICT (name) DO UPDATE SET
       category = EXCLUDED.category,
       description = EXCLUDED.description,
       run_mode = EXCLUDED.run_mode,
       source_path = EXCLUDED.source_path,
       version_hash = EXCLUDED.version_hash,
       enabled = EXCLUDED.enabled,
       content = EXCLUDED.content,
       tags_json = EXCLUDED.tags_json,
       metadata_json = EXCLUDED.metadata_json,
       updated_at = now()
     RETURNING *`,
    [
      input.name,
      input.category ?? 'general',
      input.description ?? '',
      input.runMode ?? 'manual',
      input.sourcePath ?? '',
      input.versionHash ?? '',
      input.enabled ?? true,
      input.content ?? '',
      JSON.stringify(input.tags ?? []),
      JSON.stringify(input.metadata ?? {}),
    ],
  );
  return rowToRecord(assertRow(rows.rows[0]));
}

export async function loadSkill(name: string): Promise<SkillRecord | null> {
  await ensureSkillStore();
  const db = getDb();
  const rows = await db.query<SkillRow>('SELECT * FROM skills WHERE name = $1', [name]);
  if (rows.rows.length === 0) return null;
  return rowToRecord(rows.rows[0]);
}

export async function listSkills(options: {
  category?: string;
  enabled?: boolean;
} = {}): Promise<SkillRecord[]> {
  await ensureSkillStore();
  const db = getDb();
  const clauses: string[] = [];
  const params: unknown[] = [];
  let idx = 1;

  if (options.category) {
    clauses.push(`category = $${idx++}`);
    params.push(options.category);
  }
  if (options.enabled !== undefined) {
    clauses.push(`enabled = $${idx++}`);
    params.push(options.enabled);
  }

  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  const rows = await db.query<SkillRow>(
    `SELECT * FROM skills ${where} ORDER BY usage_count DESC, updated_at DESC`,
    params,
  );
  return rows.rows.map(rowToRecord);
}

export async function deleteSkill(name: string): Promise<boolean> {
  await ensureSkillStore();
  const db = getDb();
  const rows = await db.query('DELETE FROM skills WHERE name = $1 RETURNING name', [name]);
  return rows.rows.length > 0;
}

export async function incrementSkillUsage(name: string): Promise<void> {
  await ensureSkillStore();
  const db = getDb();
  await db.query(
    'UPDATE skills SET usage_count = usage_count + 1, last_used = now() WHERE name = $1',
    [name],
  );
}

// ── Helpers ───────────────────────────────────────────────

function rowToRecord(row: SkillRow): SkillRecord {
  let tags: string[] = [];
  try { tags = JSON.parse(row.tags_json); } catch {}
  let metadata: Record<string, unknown> = {};
  try { metadata = JSON.parse(row.metadata_json); } catch {}

  return {
    name: row.name,
    category: row.category,
    description: row.description,
    runMode: row.run_mode as SkillRunMode,
    sourcePath: row.source_path,
    versionHash: row.version_hash,
    usageCount: row.usage_count,
    lastUsed: row.last_used ?? undefined,
    enabled: row.enabled,
    content: row.content,
    tags,
    metadata,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function assertRow<T>(row: T | undefined): T {
  if (!row) throw new Error('upsert returned no row');
  return row;
}
