import type { FastifyInstance } from 'fastify';
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

export function registerProjectRoutes(app: FastifyInstance) {
  // ── List ────────────────────────────────────────────
  app.get('/projects', async () => {
    const projects = listProjects();
    const defaultId = getDefaultProjectId();
    return { projects, defaultProjectId: defaultId ?? null };
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
