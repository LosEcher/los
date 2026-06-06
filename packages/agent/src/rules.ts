/**
 * @los/agent/rules — Persistent rule registry.
 *
 * Stores policy rules in PostgreSQL.
 * Follows the memory package pattern:
 *   - metadata_json carries scope ("global"|"project"), ruleLayer ("user"|"project"|"system"), archived
 *   - File sync reads/writes /etc/los/rules/ (system), ~/.los/rules/ (global), and <project>/.los/rules/ (project)
 */
import { getDb } from '@los/infra/db';
import { writeFileSync, readFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join, resolve, relative } from 'node:path';
import { getLogger } from '@los/infra/logger';

const log = getLogger('rules');

// ── Types ────────────────────────────────────────────────

export type RuleScope = 'global' | 'project';
export type RuleSeverity = 'info' | 'warn' | 'error' | 'block';
export type RuleEnforcementMode = 'advisory' | 'required';
export type RuleStatus = 'active' | 'inactive' | 'draft';
export type RuleLayer = 'user' | 'project' | 'system';

export interface RuleRecord {
  id: string;
  name: string;
  severity: RuleSeverity;
  enforcementMode: RuleEnforcementMode;
  status: RuleStatus;
  content: string;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface UpsertRuleInput {
  name: string;
  severity?: RuleSeverity;
  enforcementMode?: RuleEnforcementMode;
  status?: RuleStatus;
  content?: string;
  metadata?: Record<string, unknown>;
}

interface RuleRow {
  id: string;
  name: string;
  severity: string;
  enforcement_mode: string;
  status: string;
  content: string;
  metadata_json: unknown;
  created_at: string;
  updated_at: string;
}

// ── Schema ────────────────────────────────────────────────

const SCHEMA = `
CREATE TABLE IF NOT EXISTS rules (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'warn',
  enforcement_mode TEXT NOT NULL DEFAULT 'advisory',
  status TEXT NOT NULL DEFAULT 'active',
  content TEXT NOT NULL DEFAULT '',
  metadata_json JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE rules ADD COLUMN IF NOT EXISTS id TEXT;
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'rules' AND column_name = 'scope'
  ) THEN
    UPDATE rules
    SET metadata_json = metadata_json || jsonb_build_object(
      'scope', scope,
      'ruleLayer', CASE WHEN scope = 'global' THEN 'user' ELSE 'project' END
    )
    WHERE metadata_json->>'scope' IS NULL;
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'rules' AND column_name = 'attached_sessions_json'
  ) THEN
    UPDATE rules
    SET metadata_json = metadata_json || jsonb_build_object('attachedSessions', attached_sessions_json)
    WHERE attached_sessions_json IS NOT NULL AND metadata_json->'attachedSessions' IS NULL;
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'rules' AND column_name = 'attached_tasks_json'
  ) THEN
    UPDATE rules
    SET metadata_json = metadata_json || jsonb_build_object('attachedTasks', attached_tasks_json)
    WHERE attached_tasks_json IS NOT NULL AND metadata_json->'attachedTasks' IS NULL;
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'rules' AND column_name = 'last_changed'
  ) THEN
    UPDATE rules
    SET metadata_json = metadata_json || jsonb_build_object('lastChanged', last_changed)
    WHERE last_changed IS NOT NULL AND metadata_json->'lastChanged' IS NULL;
  END IF;
END $$;
UPDATE rules
SET metadata_json = metadata_json || '{"scope":"project","ruleLayer":"project","archived":false}'::jsonb
WHERE metadata_json->>'scope' IS NULL;
UPDATE rules
SET id = coalesce(metadata_json->>'scope', 'project') || ':' || name
WHERE id IS NULL OR id = '';
DROP INDEX IF EXISTS idx_rules_scope;
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'rules_pkey'
      AND conrelid = 'rules'::regclass
      AND pg_get_constraintdef(oid) LIKE 'PRIMARY KEY (name)%'
  ) THEN
    ALTER TABLE rules DROP CONSTRAINT rules_pkey;
  END IF;
END $$;
ALTER TABLE rules ALTER COLUMN id SET NOT NULL;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'rules_pkey' AND conrelid = 'rules'::regclass
  ) THEN
    ALTER TABLE rules ADD CONSTRAINT rules_pkey PRIMARY KEY (id);
  END IF;
END $$;
ALTER TABLE rules DROP COLUMN IF EXISTS scope;
ALTER TABLE rules DROP COLUMN IF EXISTS last_changed;
ALTER TABLE rules DROP COLUMN IF EXISTS attached_sessions_json;
ALTER TABLE rules DROP COLUMN IF EXISTS attached_tasks_json;
CREATE INDEX IF NOT EXISTS idx_rules_status ON rules(status);
CREATE INDEX IF NOT EXISTS idx_rules_severity ON rules(severity);
CREATE INDEX IF NOT EXISTS idx_rules_scope ON rules ((metadata_json->>'scope'));
CREATE INDEX IF NOT EXISTS idx_rules_layer ON rules ((metadata_json->>'ruleLayer'));
CREATE INDEX IF NOT EXISTS idx_rules_archived ON rules ((metadata_json->>'archived'));
CREATE UNIQUE INDEX IF NOT EXISTS idx_rules_scope_name_unique ON rules ((coalesce(metadata_json->>'scope', 'project')), name);
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
  assertSafeName(input.name);
  const db = getDb();
  const metadata = normalizeRuleMetadata(input.metadata);
  const id = scopedId(input.name, String(metadata.scope));
  const rows = await db.query<RuleRow>(
    `INSERT INTO rules (id, name, severity, enforcement_mode, status, content, metadata_json, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, now())
     ON CONFLICT (id) DO UPDATE SET
       severity = EXCLUDED.severity,
       enforcement_mode = EXCLUDED.enforcement_mode,
       status = EXCLUDED.status,
       content = EXCLUDED.content,
       metadata_json = EXCLUDED.metadata_json,
       updated_at = now()
     RETURNING *`,
    [
      id,
      input.name,
      input.severity ?? 'warn',
      input.enforcementMode ?? 'advisory',
      input.status ?? 'active',
      input.content ?? '',
      JSON.stringify(metadata),
    ],
  );
  return rowToRecord(assertRow(rows.rows[0]));
}

export async function loadRule(name: string, scope?: RuleScope): Promise<RuleRecord | null> {
  await ensureRuleStore();
  const db = getDb();
  const rows = scope
    ? await db.query<RuleRow>('SELECT * FROM rules WHERE id = $1', [scopedId(name, scope)])
    : await db.query<RuleRow>(`
        SELECT * FROM rules
        WHERE name = $1
        ORDER BY CASE coalesce(metadata_json->>'scope', 'project') WHEN 'project' THEN 0 WHEN 'global' THEN 1 ELSE 2 END, updated_at DESC
        LIMIT 1
      `, [name]);
  if (rows.rows.length === 0) return null;
  return rowToRecord(rows.rows[0]);
}

export async function listRules(options: {
  status?: RuleStatus;
  severity?: RuleSeverity;
  scope?: RuleScope;
  ruleLayer?: RuleLayer;
  archived?: boolean;
} = {}): Promise<RuleRecord[]> {
  await ensureRuleStore();
  const db = getDb();
  const clauses: string[] = [];
  const params: unknown[] = [];
  let idx = 1;

  if (options.status) {
    clauses.push(`status = $${idx++}`);
    params.push(options.status);
  }
  if (options.severity) {
    clauses.push(`severity = $${idx++}`);
    params.push(options.severity);
  }
  if (options.scope) {
    clauses.push(`metadata_json->>'scope' = $${idx++}`);
    params.push(options.scope);
  }
  if (options.ruleLayer) {
    clauses.push(`metadata_json->>'ruleLayer' = $${idx++}`);
    params.push(options.ruleLayer);
  }
  if (options.archived !== undefined) {
    clauses.push(`coalesce(metadata_json->>'archived', 'false') = $${idx++}`);
    params.push(String(options.archived));
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
  scope?: RuleScope,
): Promise<RuleRecord | null> {
  await ensureRuleStore();
  const db = getDb();
  const rows = scope
    ? await db.query<RuleRow>(
        `UPDATE rules SET status = $2, updated_at = now() WHERE id = $1 RETURNING *`,
        [scopedId(name, scope), status],
      )
    : await db.query<RuleRow>(
        `UPDATE rules SET status = $2, updated_at = now() WHERE name = $1 RETURNING *`,
        [name, status],
      );
  if (rows.rows.length === 0) return null;
  return rowToRecord(rows.rows[0]);
}

export async function deleteRule(name: string, scope?: RuleScope): Promise<boolean> {
  await ensureRuleStore();
  const db = getDb();
  const rows = scope
    ? await db.query('DELETE FROM rules WHERE id = $1 RETURNING id', [scopedId(name, scope)])
    : await db.query('DELETE FROM rules WHERE name = $1 RETURNING id', [name]);
  return rows.rows.length > 0;
}

// ── File Sync ────────────────────────────────────────────

export function ruleDirForScope(scope: RuleScope, workspaceRoot?: string, layer?: RuleLayer): string {
  if (layer === 'system') {
    return '/etc/los/rules';
  }
  if (scope === 'global') {
    const home = process.env.HOME ?? process.env.USERPROFILE ?? '/tmp';
    return join(home, '.los', 'rules');
  }
  return join(workspaceRoot ?? process.cwd(), '.los', 'rules');
}

export function syncRulesToDir(
  scope: RuleScope,
  rules: Pick<RuleRecord, 'name' | 'content' | 'severity' | 'enforcementMode' | 'status' | 'metadata'>[],
  workspaceRoot?: string,
  layer?: RuleLayer,
): void {
  const dir = ruleDirForScope(scope, workspaceRoot, layer);
  mkdirSync(dir, { recursive: true });

  for (const rule of rules) {
    assertSafeName(rule.name);
    const lines = [
      '---',
      `name: ${rule.name}`,
      `severity: ${rule.severity}`,
      `enforcementMode: ${rule.enforcementMode}`,
      `status: ${rule.status}`,
      `scope: ${scope}`,
      `ruleLayer: ${metadataString(rule.metadata.ruleLayer) ?? defaultRuleLayer(scope, layer)}`,
    ];
    if (rule.metadata?.description) lines.push(`description: ${rule.metadata.description}`);
    lines.push('---', '', rule.content);
    const path = safeJoin(dir, `${rule.name}.md`);
    writeFileSync(path, lines.join('\n'), 'utf-8');
  }
  log.debug(`Synced ${rules.length} rules to ${dir}`);
}

export function loadRulesFromDir(
  scope: RuleScope,
  workspaceRoot?: string,
  layer?: RuleLayer,
): UpsertRuleInput[] {
  const dir = ruleDirForScope(scope, workspaceRoot, layer);
  if (!existsSync(dir)) return [];

  const results: UpsertRuleInput[] = [];

  for (const entry of readdirSync(dir)) {
    if (!entry.endsWith('.md')) continue;
    const path = safeJoin(dir, entry);
    const raw = readFileSync(path, 'utf-8');
    const match = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
    if (!match) continue;

    const frontmatter = match[1]!;
    const content = match[2]!.trim();
    const metadata: Record<string, unknown> = { scope, ruleLayer: defaultRuleLayer(scope, layer) };
    let name = '';
    let severity: RuleSeverity = 'warn';
    let enforcementMode: RuleEnforcementMode = 'advisory';
    let status: RuleStatus = 'active';

    for (const line of frontmatter.split('\n')) {
      const kv = line.match(/^(\w+):\s*(.+)$/);
      if (!kv) continue;
      const [, key, value] = kv;
      const trimmed = value!.trim();
      if (key === 'name') name = trimmed;
      else if (key === 'severity' && isRuleSeverity(trimmed)) severity = trimmed;
      else if (key === 'enforcementMode' && isEnforcementMode(trimmed)) enforcementMode = trimmed;
      else if (key === 'status' && isRuleStatus(trimmed)) status = trimmed;
      else metadata[key] = trimmed;
    }

    if (name) {
      assertSafeName(name);
      results.push({ name, content, severity, enforcementMode, status, metadata: normalizeRuleMetadata(metadata) });
    }
  }
  return results;
}

// ── Helpers ───────────────────────────────────────────────

function rowToRecord(row: RuleRow): RuleRecord {
  return {
    id: row.id,
    name: row.name,
    severity: row.severity as RuleSeverity,
    enforcementMode: row.enforcement_mode as RuleEnforcementMode,
    status: row.status as RuleStatus,
    content: row.content,
    metadata: normalizeJsonObject(row.metadata_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function assertRow<T>(row: T | undefined): T {
  if (!row) throw new Error('upsert returned no row');
  return row;
}

function normalizeRuleMetadata(metadata: Record<string, unknown> | undefined): Record<string, unknown> {
  const scope = metadata?.scope === 'global' ? 'global' : 'project';
  const ruleLayer = metadata?.ruleLayer === 'system' || metadata?.ruleLayer === 'user' || metadata?.ruleLayer === 'project'
    ? metadata.ruleLayer
    : defaultRuleLayer(scope);
  return {
    ...(metadata ?? {}),
    scope,
    ruleLayer,
    archived: metadata?.archived === true || metadata?.archived === 'true',
  };
}

function defaultRuleLayer(scope: RuleScope, requested?: RuleLayer): RuleLayer {
  if (requested === 'system') return 'system';
  return scope === 'global' ? 'user' : 'project';
}

function scopedId(name: string, scope: string): string {
  return `${scope}:${name}`;
}

function assertSafeName(name: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(name) || name === '.' || name === '..') {
    throw new Error(`Invalid rule name for filesystem sync: ${name}`);
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

function isRuleSeverity(value: string): value is RuleSeverity {
  return value === 'info' || value === 'warn' || value === 'error' || value === 'block';
}

function isEnforcementMode(value: string): value is RuleEnforcementMode {
  return value === 'advisory' || value === 'required';
}

function isRuleStatus(value: string): value is RuleStatus {
  return value === 'active' || value === 'inactive' || value === 'draft';
}
