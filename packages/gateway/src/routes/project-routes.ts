import type { FastifyInstance } from 'fastify';
import { readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import {
  bindProject,
  getDefaultProjectId,
  getProject,
  listProjects,
  setDefaultProjectId,
  touchProject,
  unbindProject,
  validateProjectPath,
} from '../project-store.js';

function sanitizeProjectId(raw: string): string {
  return raw.replace(/[^A-Za-z0-9._-]/g, '-').replace(/^-+/, '').replace(/-+$/, '') || 'untitled';
}

const SAFE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const MAX_DIRECTORY_ENTRIES = 200;

function normalizeBrowsePath(raw: unknown): string {
  const fallback = process.cwd();
  if (typeof raw !== 'string') return fallback;
  const trimmed = raw.trim();
  if (!trimmed) return fallback;
  if (trimmed === '~') return homedir();
  if (trimmed.startsWith('~/')) return resolve(homedir(), trimmed.slice(2));
  return resolve(trimmed);
}

function browseDirectory(path: string): {
  path: string;
  parent: string | null;
  entries: Array<{ name: string; path: string; hidden: boolean }>;
  roots: Array<{ label: string; path: string }>;
} {
  const stat = statSync(path);
  if (!stat.isDirectory()) {
    throw new Error('Path exists but is not a directory');
  }
  const parent = dirname(path);
  const entries = readdirSync(path, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => ({
      name: entry.name,
      path: resolve(path, entry.name),
      hidden: entry.name.startsWith('.'),
    }))
    .sort((a, b) => {
      if (a.hidden !== b.hidden) return a.hidden ? 1 : -1;
      return a.name.localeCompare(b.name);
    })
    .slice(0, MAX_DIRECTORY_ENTRIES);

  return {
    path,
    parent: parent === path ? null : parent,
    entries,
    roots: [
      { label: 'workspace', path: process.cwd() },
      { label: 'projects', path: resolve(homedir(), 'projects') },
      { label: 'home', path: homedir() },
    ],
  };
}

export function registerProjectRoutes(app: FastifyInstance) {
  // ── List ────────────────────────────────────────────
  app.get('/projects', async () => {
    const projects = listProjects();
    const defaultId = getDefaultProjectId();
    return { projects, defaultProjectId: defaultId ?? null };
  });

  // ── Browse local directories for project binding ─────
  app.get('/projects/browse', async (req, reply) => {
    const query = req.query as { path?: string };
    const path = normalizeBrowsePath(query.path);
    try {
      return browseDirectory(path);
    } catch (err) {
      return reply.status(400).send({
        error: err instanceof Error ? err.message : String(err),
        path,
      });
    }
  });

  // ── Get one ─────────────────────────────────────────
  app.get('/projects/:projectId', async (req, reply) => {
    const { projectId } = req.params as { projectId: string };
    const project = getProject(projectId);
    if (!project) return reply.status(404).send({ error: 'Project not found' });
    return project;
  });

  // ── Bind ────────────────────────────────────────────
  app.post('/projects/bind', async (req, reply) => {
    const body = req.body as {
      workspacePath?: string;
      projectId?: string;
      displayName?: string;
    };

    const workspacePath = body.workspacePath?.trim();
    if (!workspacePath) {
      return reply.status(400).send({ error: 'workspacePath is required' });
    }

    // Validate path
    const validation = validateProjectPath(workspacePath);
    if (!validation.valid) {
      return reply.status(400).send({ error: validation.error });
    }

    // Derive projectId from folder name if not provided
    const projectId = body.projectId?.trim() ||
      sanitizeProjectId(workspacePath.split('/').pop() ?? 'untitled');

    if (!SAFE_ID_RE.test(projectId)) {
      return reply.status(400).send({ error: 'projectId must be a safe identifier' });
    }

    // Derive displayName
    const displayName = (body.displayName?.trim() ||
      workspacePath.split('/').pop()) ?? projectId;

    const project = bindProject({ projectId, displayName, workspacePath });
    return reply.status(201).send(project);
  });

  // ── Unbind ──────────────────────────────────────────
  app.delete('/projects/:projectId', async (req, reply) => {
    const { projectId } = req.params as { projectId: string };
    const ok = unbindProject(projectId);
    if (!ok) return reply.status(404).send({ error: 'Project not found' });
    return { ok: true };
  });

  // ── Touch (update lastUsed) ─────────────────────────
  app.post('/projects/:projectId/touch', async (req, reply) => {
    const { projectId } = req.params as { projectId: string };
    const ok = touchProject(projectId);
    if (!ok) return reply.status(404).send({ error: 'Project not found' });
    return { ok: true };
  });

  // ── Set default ─────────────────────────────────────
  app.post('/projects/default', async (req, reply) => {
    const body = req.body as { projectId?: string; workspacePath?: string };
    const projectId = body.projectId?.trim();
    const workspacePath = body.workspacePath?.trim();

    if (projectId) {
      const project = getProject(projectId);
      if (!project) return reply.status(404).send({ error: 'Project not found' });
      setDefaultProjectId(projectId);
      return { defaultProjectId: projectId };
    }

    if (workspacePath) {
      const projects = listProjects();
      const match = projects.find(p => p.workspacePath === workspacePath);
      if (match) {
        setDefaultProjectId(match.projectId);
        return { defaultProjectId: match.projectId };
      }
      return reply.status(404).send({ error: 'No project found with that workspacePath' });
    }

    return reply.status(400).send({ error: 'projectId or workspacePath is required' });
  });

  // ── Validate path ───────────────────────────────────
  app.post('/projects/validate', async (req, reply) => {
    const body = req.body as { workspacePath?: string };
    const workspacePath = body.workspacePath?.trim();
    if (!workspacePath) {
      return reply.status(400).send({ error: 'workspacePath is required' });
    }
    const validation = validateProjectPath(workspacePath);
    return validation;
  });
}
