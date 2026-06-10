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

export function registerSkillRoutes(app: FastifyInstance, defaultWorkspaceRoot?: string) {
  app.get('/skills', async (req) => {
    const query = req.query as {
      category?: string;
      enabled?: string;
      scope?: string;
      skillLayer?: string;
      archived?: string;
    };
    await ensureSkillStore();
    return await listSkills({
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
    await ensureSkillStore();
    const skill = await loadSkill(name, normalizeScope(query.scope));
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

    await ensureSkillStore();
    const skill = await upsertSkill({
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
    await ensureSkillStore();
    const ok = await deleteSkill(name, normalizeScope(query.scope));
    if (!ok) return reply.status(404).send({ error: 'Skill not found' });
    return { ok: true };
  });

  // ── File Sync ──────────────────────────────────────────

  app.post('/skills/sync-to-dir', async (req) => {
    const body = req.body as { scope?: string; skillLayer?: string; workspaceRoot?: string };
    const layer = normalizeSkillLayer(body.skillLayer);
    const scope = layer === 'system' ? 'global' : normalizeScope(body.scope) ?? 'global';
    const skillLayer = layer ?? defaultSkillLayer(scope);
    const workspaceRoot = normalizeOptionalString(body.workspaceRoot) ?? defaultWorkspaceRoot;
    await ensureSkillStore();
    const skills = await listSkills({ scope, skillLayer, enabled: true });
    syncSkillsToDir(scope, skills, workspaceRoot, skillLayer);
    return { ok: true, count: skills.length, scope, skillLayer };
  });

  app.post('/skills/load-from-dir', async (req, reply) => {
    const body = req.body as { scope?: string; skillLayer?: string; workspaceRoot?: string };
    const layer = normalizeSkillLayer(body.skillLayer);
    const scope = layer === 'system' ? 'global' : normalizeScope(body.scope) ?? 'global';
    const skillLayer = layer ?? defaultSkillLayer(scope);
    const workspaceRoot = normalizeOptionalString(body.workspaceRoot) ?? defaultWorkspaceRoot;
    const loaded = loadSkillsFromDir(scope, workspaceRoot, skillLayer);
    await ensureSkillStore();
    const upserted = [];
    for (const item of loaded) {
      upserted.push(await upsertSkill({
        name: item.name,
        category: item.category,
        description: item.description,
        runMode: item.runMode,
        content: item.content,
        metadata: item.metadata,
        enabled: item.enabled,
      }));
    }
    return reply.status(201).send({ ok: true, count: upserted.length, scope, skillLayer, skills: upserted });
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
