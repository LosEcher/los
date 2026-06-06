/**
 * @los/agent/skills — Persistent skill registry.
 *
 * Stores reusable agent instruction bundles (skills) in PostgreSQL.
 * Follows the memory package pattern:
 *   - metadata_json carries scope ("global"|"project"), skillLayer ("user"|"project"|"system"), archived
 *   - File sync reads/writes /etc/los/skills/ (system), ~/.los/skills/ (global), and <project>/.los/skills/ (project)
 */
import { getDb } from '@los/infra/db';
import { writeFileSync, readFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join, resolve, relative } from 'node:path';
import { getLogger } from '@los/infra/logger';

const log = getLogger('skills');

// ── Types ────────────────────────────────────────────────

export type SkillRunMode = 'auto' | 'manual';
export type SkillScope = 'global' | 'project';
export type SkillLayer = 'user' | 'project' | 'system';

export interface SkillRecord {
  id: string;
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
  id: string;
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
  tags_json: unknown;
  metadata_json: unknown;
  created_at: string;
  updated_at: string;
}

// ── Schema ────────────────────────────────────────────────

const SCHEMA = `
CREATE TABLE IF NOT EXISTS skills (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
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
ALTER TABLE skills ADD COLUMN IF NOT EXISTS id TEXT;
UPDATE skills
SET metadata_json = metadata_json || '{"scope":"project","skillLayer":"project","archived":false}'::jsonb
WHERE metadata_json->>'scope' IS NULL;
UPDATE skills
SET id = coalesce(metadata_json->>'scope', 'project') || ':' || name
WHERE id IS NULL OR id = '';
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'skills_pkey'
      AND conrelid = 'skills'::regclass
      AND pg_get_constraintdef(oid) LIKE 'PRIMARY KEY (name)%'
  ) THEN
    ALTER TABLE skills DROP CONSTRAINT skills_pkey;
  END IF;
END $$;
ALTER TABLE skills ALTER COLUMN id SET NOT NULL;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'skills_pkey' AND conrelid = 'skills'::regclass
  ) THEN
    ALTER TABLE skills ADD CONSTRAINT skills_pkey PRIMARY KEY (id);
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS idx_skills_category ON skills(category);
CREATE INDEX IF NOT EXISTS idx_skills_enabled ON skills(enabled);
CREATE INDEX IF NOT EXISTS idx_skills_scope ON skills ((metadata_json->>'scope'));
CREATE INDEX IF NOT EXISTS idx_skills_layer ON skills ((metadata_json->>'skillLayer'));
CREATE INDEX IF NOT EXISTS idx_skills_archived ON skills ((metadata_json->>'archived'));
CREATE UNIQUE INDEX IF NOT EXISTS idx_skills_scope_name_unique ON skills ((coalesce(metadata_json->>'scope', 'project')), name);
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
  assertSafeName(input.name);
  const db = getDb();
  const metadata = normalizeSkillMetadata(input.metadata);
  const id = scopedId(input.name, String(metadata.scope));
  const rows = await db.query<SkillRow>(
    `INSERT INTO skills (id, name, category, description, run_mode, source_path, version_hash, enabled, content, tags_json, metadata_json, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11::jsonb, now())
     ON CONFLICT (id) DO UPDATE SET
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
      id,
      input.name,
      input.category ?? 'general',
      input.description ?? '',
      input.runMode ?? 'manual',
      input.sourcePath ?? '',
      input.versionHash ?? '',
      input.enabled ?? true,
      input.content ?? '',
      JSON.stringify(input.tags ?? []),
      JSON.stringify(metadata),
    ],
  );
  return rowToRecord(assertRow(rows.rows[0]));
}

export async function loadSkill(name: string, scope?: SkillScope): Promise<SkillRecord | null> {
  await ensureSkillStore();
  const db = getDb();
  const rows = scope
    ? await db.query<SkillRow>('SELECT * FROM skills WHERE id = $1', [scopedId(name, scope)])
    : await db.query<SkillRow>(`
        SELECT * FROM skills
        WHERE name = $1
        ORDER BY CASE coalesce(metadata_json->>'scope', 'project') WHEN 'project' THEN 0 WHEN 'global' THEN 1 ELSE 2 END, updated_at DESC
        LIMIT 1
      `, [name]);
  if (rows.rows.length === 0) return null;
  return rowToRecord(rows.rows[0]);
}

export async function listSkills(options: {
  category?: string;
  enabled?: boolean;
  scope?: SkillScope;
  skillLayer?: SkillLayer;
  archived?: boolean;
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
  if (options.scope) {
    clauses.push(`metadata_json->>'scope' = $${idx++}`);
    params.push(options.scope);
  }
  if (options.skillLayer) {
    clauses.push(`metadata_json->>'skillLayer' = $${idx++}`);
    params.push(options.skillLayer);
  }
  if (options.archived !== undefined) {
    clauses.push(`coalesce(metadata_json->>'archived', 'false') = $${idx++}`);
    params.push(String(options.archived));
  }

  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  const rows = await db.query<SkillRow>(
    `SELECT * FROM skills ${where} ORDER BY usage_count DESC, updated_at DESC`,
    params,
  );
  return rows.rows.map(rowToRecord);
}

export async function deleteSkill(name: string, scope?: SkillScope): Promise<boolean> {
  await ensureSkillStore();
  const db = getDb();
  const rows = scope
    ? await db.query('DELETE FROM skills WHERE id = $1 RETURNING id', [scopedId(name, scope)])
    : await db.query('DELETE FROM skills WHERE name = $1 RETURNING id', [name]);
  return rows.rows.length > 0;
}

export async function incrementSkillUsage(name: string, scope?: SkillScope): Promise<void> {
  await ensureSkillStore();
  const db = getDb();
  if (scope) {
    await db.query(
      'UPDATE skills SET usage_count = usage_count + 1, last_used = now() WHERE id = $1',
      [scopedId(name, scope)],
    );
    return;
  }
  await db.query('UPDATE skills SET usage_count = usage_count + 1, last_used = now() WHERE name = $1', [name]);
}

// ── File Sync ────────────────────────────────────────────

export function skillDirForScope(scope: SkillScope, workspaceRoot?: string, layer?: SkillLayer): string {
  if (layer === 'system') {
    return '/etc/los/skills';
  }
  if (scope === 'global') {
    const home = process.env.HOME ?? process.env.USERPROFILE ?? '/tmp';
    return join(home, '.los', 'skills');
  }
  return join(workspaceRoot ?? process.cwd(), '.los', 'skills');
}

export function syncSkillsToDir(
  scope: SkillScope,
  skills: Pick<SkillRecord, 'name' | 'content' | 'metadata' | 'enabled'>[],
  workspaceRoot?: string,
  layer?: SkillLayer,
): void {
  const dir = skillDirForScope(scope, workspaceRoot, layer);
  mkdirSync(dir, { recursive: true });

  for (const skill of skills) {
    assertSafeName(skill.name);
    const lines = [
      '---',
      `name: ${skill.name}`,
      `enabled: ${skill.enabled}`,
      `scope: ${scope}`,
      `skillLayer: ${metadataString(skill.metadata.skillLayer) ?? defaultSkillLayer(scope, layer)}`,
    ];
    if (skill.metadata?.category) lines.push(`category: ${skill.metadata.category}`);
    if (skill.metadata?.runMode) lines.push(`runMode: ${skill.metadata.runMode}`);
    if (skill.metadata?.description) lines.push(`description: ${skill.metadata.description}`);
    lines.push('---', '', skill.content);
    const path = safeJoin(dir, `${skill.name}.md`);
    writeFileSync(path, lines.join('\n'), 'utf-8');
  }
  log.debug(`Synced ${skills.length} skills to ${dir}`);
}

export function loadSkillsFromDir(
  scope: SkillScope,
  workspaceRoot?: string,
  layer?: SkillLayer,
): Array<UpsertSkillInput> {
  const dir = skillDirForScope(scope, workspaceRoot, layer);
  if (!existsSync(dir)) return [];

  const results: UpsertSkillInput[] = [];

  for (const entry of readdirSync(dir)) {
    if (!entry.endsWith('.md')) continue;
    const path = safeJoin(dir, entry);
    const raw = readFileSync(path, 'utf-8');
    const parsed = parseSkillMarkdown(raw, entry);
    if (parsed) {
      results.push({
        ...parsed,
        metadata: normalizeSkillMetadata({
          ...parsed.metadata,
          scope,
          skillLayer: defaultSkillLayer(scope, layer),
        }),
      });
    }
  }
  return results;
}

function parseSkillMarkdown(raw: string, filename: string): UpsertSkillInput | null {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) {
    const name = filename.replace(/\.md$/i, '');
    assertSafeName(name);
    return { name, content: raw, metadata: {}, enabled: true };
  }

  const frontmatter = match[1]!;
  const content = match[2]!.trim();
  const metadata: Record<string, unknown> = {};
  let name = '';
  let enabled = true;
  let category: string | undefined;
  let description: string | undefined;
  let runMode: SkillRunMode | undefined;

  for (const line of frontmatter.split('\n')) {
    const kv = line.match(/^(\w+):\s*(.+)$/);
    if (!kv) continue;
    const [, key, value] = kv;
    const trimmed = value!.trim();
    if (key === 'name') name = trimmed;
    else if (key === 'enabled') enabled = trimmed !== 'false';
    else if (key === 'category') category = trimmed;
    else if (key === 'description') description = trimmed;
    else if (key === 'runMode' && (trimmed === 'auto' || trimmed === 'manual')) runMode = trimmed;
    else metadata[key] = trimmed;
  }

  if (!name) return null;
  assertSafeName(name);
  return { name, category, description, runMode, content, metadata, enabled };
}

// ── Helpers ───────────────────────────────────────────────

function rowToRecord(row: SkillRow): SkillRecord {
  return {
    id: row.id,
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
    tags: normalizeJsonArray(row.tags_json),
    metadata: normalizeJsonObject(row.metadata_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function assertRow<T>(row: T | undefined): T {
  if (!row) throw new Error('upsert returned no row');
  return row;
}

function normalizeSkillMetadata(metadata: Record<string, unknown> | undefined): Record<string, unknown> {
  const scope = metadata?.scope === 'global' ? 'global' : 'project';
  const skillLayer = metadata?.skillLayer === 'system' || metadata?.skillLayer === 'user' || metadata?.skillLayer === 'project'
    ? metadata.skillLayer
    : defaultSkillLayer(scope);
  return {
    ...(metadata ?? {}),
    scope,
    skillLayer,
    archived: metadata?.archived === true || metadata?.archived === 'true',
  };
}

function defaultSkillLayer(scope: SkillScope, requested?: SkillLayer): SkillLayer {
  if (requested === 'system') return 'system';
  return scope === 'global' ? 'user' : 'project';
}

function scopedId(name: string, scope: string): string {
  return `${scope}:${name}`;
}

function assertSafeName(name: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(name) || name === '.' || name === '..') {
    throw new Error(`Invalid skill name for filesystem sync: ${name}`);
  }
}

function safeJoin(dir: string, filename: string): string {
  const root = resolve(dir);
  const target = resolve(root, filename);
  const rel = relative(root, target);
  if (rel.startsWith('..') || rel.startsWith('/') || rel === '') {
    throw new Error(`Refusing to access path outside ${root}`);
  }
  return target;
}

function metadataString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function normalizeJsonArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(item => String(item));
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed.map(item => String(item)) : [];
    } catch {
      return [];
    }
  }
  return [];
}

function normalizeJsonObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
    } catch {
      return {};
    }
  }
  return {};
}
