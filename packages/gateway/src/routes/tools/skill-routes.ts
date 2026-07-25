import type { FastifyInstance } from 'fastify';
import {
  deleteSkill,
  ensureSkillStore,
  listSkills,
  loadSkill,
  loadSkillsFromDir,
  syncSkillsToDir,
  upsertSkill,
  type SkillLayer,
  type SkillRunMode,
  type SkillScope,
} from '@los/agent/skills';
import {
  applyInspectedSkills,
  inspectSkillDirectory,
  listSkillVersions,
  pinSkillVersion,
  rollbackSkillVersion,
  unpinSkillVersion,
} from '@los/agent/skill-distribution';
export type SkillRouteDependencies = {
  ensureSkillStore: typeof ensureSkillStore;
  listSkills: typeof listSkills;
  loadSkill: typeof loadSkill;
  upsertSkill: typeof upsertSkill;
  deleteSkill: typeof deleteSkill;
  listSkillVersions: typeof listSkillVersions;
  pinSkillVersion: typeof pinSkillVersion;
  rollbackSkillVersion: typeof rollbackSkillVersion;
  unpinSkillVersion: typeof unpinSkillVersion;
  inspectSkillDirectory: typeof inspectSkillDirectory;
  applyInspectedSkills: typeof applyInspectedSkills;
  syncSkillsToDir: typeof syncSkillsToDir;
};

const defaultDependencies: SkillRouteDependencies = {
  ensureSkillStore,
  listSkills,
  loadSkill,
  upsertSkill,
  deleteSkill,
  listSkillVersions,
  pinSkillVersion,
  rollbackSkillVersion,
  unpinSkillVersion,
  inspectSkillDirectory,
  applyInspectedSkills,
  syncSkillsToDir,
};

export function registerSkillRoutes(
  app: FastifyInstance,
  defaultWorkspaceRoot?: string,
  deps: SkillRouteDependencies = defaultDependencies,
) {
  app.get('/skills', async (req) => {
    const query = req.query as {
      category?: string;
      enabled?: string;
      scope?: string;
      skillLayer?: string;
      archived?: string;
    };
    await deps.ensureSkillStore();
    return await deps.listSkills({
      category: normalizeOptionalString(query.category),
      enabled: query.enabled === 'true' ? true : query.enabled === 'false' ? false : undefined,
      scope: normalizeScope(query.scope),
      skillLayer: normalizeSkillLayer(query.skillLayer),
      archived: query.archived === 'true' ? true : query.archived === 'false' ? false : undefined,
    });
  });

  app.get('/skills/:name', async (req, reply) => {
    const { name } = req.params as { name: string };
    const query = req.query as { scope?: string };
    await deps.ensureSkillStore();
    const skill = await deps.loadSkill(name, normalizeScope(query.scope));
    if (!skill) return reply.status(404).send({ error: 'Skill not found' });
    return skill;
  });

  app.post('/skills', async (req, reply) => {
    const body = req.body as {
      name?: string;
      category?: string;
      description?: string;
      runMode?: string;
      sourcePath?: string;
      versionHash?: string;
      enabled?: boolean;
      content?: string;
      tags?: string[];
      scope?: string;
      skillLayer?: string;
      metadata?: Record<string, unknown>;
    };

    const name = normalizeOptionalString(body.name);
    if (!name) return reply.status(400).send({ error: 'name is required' });
    if (!isSafeRegistryName(name)) return reply.status(400).send({ error: 'name must be a safe registry identifier' });

    const scope = normalizeScope(body.scope) ?? 'project';
    const skillLayer = normalizeSkillLayer(body.skillLayer) ?? defaultSkillLayer(scope);

    const metadata: Record<string, unknown> = { ...(body.metadata ?? {}) };
    metadata.scope = scope;
    metadata.skillLayer = skillLayer;
    if (metadata.archived === undefined) metadata.archived = false;

    await deps.ensureSkillStore();
    const skill = await deps.upsertSkill({
      name,
      category: normalizeOptionalString(body.category),
      description: normalizeOptionalString(body.description),
      runMode: normalizeRunMode(body.runMode),
      sourcePath: normalizeOptionalString(body.sourcePath),
      versionHash: normalizeOptionalString(body.versionHash),
      enabled: body.enabled,
      content: normalizeOptionalString(body.content),
      tags: body.tags,
      metadata,
    });
    return reply.status(201).send(skill);
  });

  app.delete('/skills/:name', async (req, reply) => {
    const { name } = req.params as { name: string };
    const query = req.query as { scope?: string };
    await deps.ensureSkillStore();
    const ok = await deps.deleteSkill(name, normalizeScope(query.scope));
    if (!ok) return reply.status(404).send({ error: 'Skill not found' });
    return { ok: true };
  });

  app.get('/skills/:name/history', async (req, reply) => {
    const { name } = req.params as { name: string };
    const query = req.query as { scope?: string };
    const scope = normalizeScope(query.scope);
    if (!scope) return reply.status(400).send({ error: 'scope is required' });
    const skill = await deps.loadSkill(name, scope);
    if (!skill) return reply.status(404).send({ error: 'Skill not found' });
    return { currentVersionHash: skill.versionHash, pinnedVersionHash: skill.pinnedVersionHash, versions: await deps.listSkillVersions(name, scope) };
  });

  app.post('/skills/:name/pin', async (req, reply) => {
    const { name } = req.params as { name: string };
    const body = req.body as { scope?: string; versionHash?: string; pinned?: boolean };
    const scope = normalizeScope(body.scope);
    if (!scope) return reply.status(400).send({ error: 'scope is required' });
    try {
      return body.pinned === false
        ? await deps.unpinSkillVersion(name, scope)
        : await deps.pinSkillVersion(name, scope, normalizeOptionalString(body.versionHash));
    } catch (error) {
      return reply.status(messageOf(error).includes('not found') ? 404 : 409).send({ error: messageOf(error) });
    }
  });

  app.post('/skills/:name/rollback', async (req, reply) => {
    const { name } = req.params as { name: string };
    const body = req.body as { scope?: string; versionHash?: string };
    const scope = normalizeScope(body.scope);
    const versionHash = normalizeOptionalString(body.versionHash);
    if (!scope || !versionHash) return reply.status(400).send({ error: 'scope and versionHash are required' });
    try {
      return await deps.rollbackSkillVersion(name, scope, versionHash);
    } catch (error) {
      return reply.status(messageOf(error).includes('not found') ? 404 : 409).send({ error: messageOf(error) });
    }
  });

  // ── File Sync ──────────────────────────────────────────

  app.post('/skills/sync-to-dir', async (req) => {
    const body = req.body as { scope?: string; skillLayer?: string; workspaceRoot?: string };
    const layer = normalizeSkillLayer(body.skillLayer);
    const scope = layer === 'system' ? 'global' : normalizeScope(body.scope) ?? 'global';
    const skillLayer = layer ?? defaultSkillLayer(scope);
    const workspaceRoot = normalizeOptionalString(body.workspaceRoot) ?? defaultWorkspaceRoot;
    await deps.ensureSkillStore();
    const skills = await deps.listSkills({ scope, skillLayer, enabled: true });
    deps.syncSkillsToDir(scope, skills, workspaceRoot, skillLayer);
    return { ok: true, count: skills.length, scope, skillLayer };
  });

  app.post('/skills/import/inspect', async (req) => {
    const body = req.body as { scope?: string; skillLayer?: string; workspaceRoot?: string };
    const layer = normalizeSkillLayer(body.skillLayer);
    const scope = layer === 'system' ? 'global' : normalizeScope(body.scope) ?? 'global';
    const skillLayer = layer ?? defaultSkillLayer(scope);
    const workspaceRoot = normalizeOptionalString(body.workspaceRoot) ?? defaultWorkspaceRoot;
    await deps.ensureSkillStore();
    const skills = await deps.inspectSkillDirectory(scope, workspaceRoot, skillLayer);
    return { ok: true, count: skills.length, scope, skillLayer, skills };
  });

  app.post('/skills/import/apply', async (req, reply) => {
    const body = req.body as {
      scope?: string;
      skillLayer?: string;
      workspaceRoot?: string;
      expected?: Array<{ name?: string; versionHash?: string }>;
    };
    const layer = normalizeSkillLayer(body.skillLayer);
    const scope = layer === 'system' ? 'global' : normalizeScope(body.scope) ?? 'global';
    const skillLayer = layer ?? defaultSkillLayer(scope);
    const workspaceRoot = normalizeOptionalString(body.workspaceRoot) ?? defaultWorkspaceRoot;
    const expected = (body.expected ?? [])
      .map(item => ({ name: normalizeOptionalString(item.name), versionHash: normalizeOptionalString(item.versionHash) }))
      .filter((item): item is { name: string; versionHash: string } => Boolean(item.name && item.versionHash));
    if (expected.length === 0) return reply.status(400).send({ error: 'expected inspected name/version pairs are required' });
    try {
      const skills = await deps.applyInspectedSkills({ scope, workspaceRoot, layer: skillLayer, expected });
      return reply.status(201).send({ ok: true, count: skills.length, scope, skillLayer, skills });
    } catch (error) {
      return reply.status(409).send({ error: messageOf(error) });
    }
  });

  app.post('/skills/load-from-dir', async (req) => {
    const body = req.body as { scope?: string; skillLayer?: string; workspaceRoot?: string };
    const layer = normalizeSkillLayer(body.skillLayer);
    const scope = layer === 'system' ? 'global' : normalizeScope(body.scope) ?? 'global';
    const skillLayer = layer ?? defaultSkillLayer(scope);
    const workspaceRoot = normalizeOptionalString(body.workspaceRoot) ?? defaultWorkspaceRoot;
    const skills = await deps.inspectSkillDirectory(scope, workspaceRoot, skillLayer);
    return { ok: true, previewOnly: true, count: skills.length, scope, skillLayer, skills };
  });
}

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function normalizeRunMode(value: unknown): SkillRunMode | undefined {
  if (value === 'auto' || value === 'manual') return value;
  return undefined;
}

function normalizeScope(value: unknown): SkillScope | undefined {
  if (value === 'global' || value === 'project') return value;
  return undefined;
}

function normalizeSkillLayer(value: unknown): SkillLayer | undefined {
  if (value === 'user' || value === 'project' || value === 'system') return value;
  return undefined;
}

function defaultSkillLayer(scope: SkillScope): SkillLayer {
  return scope === 'global' ? 'user' : 'project';
}

function isSafeRegistryName(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value) && value !== '.' && value !== '..';
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
