import type { FastifyInstance } from 'fastify';
import {
  deleteSkill,
  ensureSkillStore,
  listSkills,
  loadSkill,
  upsertSkill,
  type SkillRunMode,
} from '@los/agent/skills';

export function registerSkillRoutes(app: FastifyInstance) {
  app.get('/skills', async (req) => {
    const query = req.query as { category?: string; enabled?: string };
    await ensureSkillStore();
    return await listSkills({
      category: normalizeOptionalString(query.category),
      enabled: query.enabled === 'true' ? true : query.enabled === 'false' ? false : undefined,
    });
  });

  app.get('/skills/:name', async (req, reply) => {
    const { name } = req.params as { name: string };
    await ensureSkillStore();
    const skill = await loadSkill(name);
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
      metadata?: Record<string, unknown>;
    };

    const name = normalizeOptionalString(body.name);
    if (!name) return reply.status(400).send({ error: 'name is required' });

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
      metadata: body.metadata,
    });
    return reply.status(201).send(skill);
  });

  app.delete('/skills/:name', async (req, reply) => {
    const { name } = req.params as { name: string };
    await ensureSkillStore();
    const ok = await deleteSkill(name);
    if (!ok) return reply.status(404).send({ error: 'Skill not found' });
    return { ok: true };
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
