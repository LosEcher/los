import { getDb } from '@los/infra/db';
import {
  listSkills,
  loadSkill,
  loadSkillsFromDir,
  skillVersionHash,
  upsertSkill,
  type SkillLayer,
  type SkillRecord,
  type SkillScope,
  type UpsertSkillInput,
} from './skills.js';

export type SkillImportAction = 'create' | 'update' | 'unchanged';

export interface SkillImportPreviewItem extends UpsertSkillInput {
  versionHash: string;
  currentVersionHash?: string;
  action: SkillImportAction;
}

export interface SkillVersionRecord {
  versionHash: string;
  sourcePath: string;
  snapshot: UpsertSkillInput;
  createdAt: string;
}

export async function inspectSkillDirectory(
  scope: SkillScope,
  workspaceRoot?: string,
  layer?: SkillLayer,
): Promise<SkillImportPreviewItem[]> {
  const loaded = loadSkillsFromDir(scope, workspaceRoot, layer);
  const current = await listSkills({ scope, skillLayer: layer });
  const byName = new Map(current.map(skill => [skill.name, skill]));
  return loaded.map(item => {
    const versionHash = skillVersionHash(item);
    const existing = byName.get(item.name);
    return {
      ...item,
      versionHash,
      currentVersionHash: existing?.versionHash,
      action: !existing ? 'create' : existing.versionHash === versionHash ? 'unchanged' : 'update',
    };
  });
}

export async function applyInspectedSkills(input: {
  scope: SkillScope;
  workspaceRoot?: string;
  layer?: SkillLayer;
  expected: Array<{ name: string; versionHash: string }>;
}): Promise<SkillRecord[]> {
  const preview = await inspectSkillDirectory(input.scope, input.workspaceRoot, input.layer);
  const byName = new Map(preview.map(item => [item.name, item]));
  const applied: SkillRecord[] = [];
  for (const expected of input.expected) {
    const item = byName.get(expected.name);
    if (!item || item.versionHash !== expected.versionHash) {
      throw new Error(`Skill import changed after inspect: ${expected.name}`);
    }
    if (item.action !== 'unchanged') applied.push(await upsertSkill(item));
  }
  return applied;
}

export async function listSkillVersions(name: string, scope: SkillScope): Promise<SkillVersionRecord[]> {
  const db = getDb();
  const rows = await db.query<{
    version_hash: string;
    source_path: string;
    snapshot_json: unknown;
    created_at: string | Date;
  }>(
    `SELECT version_hash, source_path, snapshot_json, created_at
     FROM skill_versions WHERE skill_id = $1 ORDER BY created_at DESC`,
    [`${scope}:${name}`],
  );
  return rows.rows.map(row => ({
    versionHash: row.version_hash,
    sourcePath: row.source_path,
    snapshot: normalizeSnapshot(row.snapshot_json),
    createdAt: new Date(row.created_at).toISOString(),
  }));
}

export async function pinSkillVersion(name: string, scope: SkillScope, versionHash?: string): Promise<SkillRecord> {
  const skill = await loadSkill(name, scope);
  if (!skill) throw new Error('Skill not found');
  const target = versionHash ?? skill.versionHash;
  const versions = await listSkillVersions(name, scope);
  if (!versions.some(version => version.versionHash === target)) throw new Error('Skill version not found');
  const db = getDb();
  const rows = await db.query('UPDATE skills SET pinned_version_hash = $1, updated_at = now() WHERE id = $2 RETURNING id', [target, skill.id]);
  if (rows.rows.length === 0) throw new Error('Skill not found');
  return (await loadSkill(name, scope))!;
}

export async function unpinSkillVersion(name: string, scope: SkillScope): Promise<SkillRecord> {
  const skill = await loadSkill(name, scope);
  if (!skill) throw new Error('Skill not found');
  await getDb().query('UPDATE skills SET pinned_version_hash = NULL, updated_at = now() WHERE id = $1', [skill.id]);
  return (await loadSkill(name, scope))!;
}

export async function rollbackSkillVersion(name: string, scope: SkillScope, versionHash: string): Promise<SkillRecord> {
  const current = await loadSkill(name, scope);
  if (!current) throw new Error('Skill not found');
  if (current.pinnedVersionHash && current.pinnedVersionHash !== versionHash) {
    throw new Error(`Skill is pinned to version ${current.pinnedVersionHash}`);
  }
  const version = (await listSkillVersions(name, scope)).find(item => item.versionHash === versionHash);
  if (!version) throw new Error('Skill version not found');
  return await upsertSkill({
    ...version.snapshot,
    name,
    versionHash,
    pinnedVersionHash: current.pinnedVersionHash ?? null,
    allowPinnedUpdate: true,
  });
}

function normalizeSnapshot(value: unknown): UpsertSkillInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid skill version snapshot');
  return value as UpsertSkillInput;
}
