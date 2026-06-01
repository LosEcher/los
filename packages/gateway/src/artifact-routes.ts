import type { FastifyInstance } from 'fastify';
import {
  deleteArtifact,
  ensureArtifactStore,
  listArtifacts,
  loadArtifact,
  putArtifact,
  readArtifactContent,
  type ArtifactPathPolicy,
} from '@los/agent/artifacts';
import { getRequestContext } from './request-context.js';

type ArtifactRoutesOptions = {
  storageRoot: string;
};

type PutArtifactBody = {
  artifactId?: string;
  nodeId?: string;
  sessionId?: string;
  taskRunId?: string;
  traceId?: string;
  requestId?: string;
  workspaceRoot?: string;
  path?: string;
  pathPolicy?: ArtifactPathPolicy;
  content?: string;
  encoding?: 'utf8' | 'base64';
  contentType?: string;
  metadata?: Record<string, unknown>;
};

export function registerArtifactRoutes(app: FastifyInstance, options: ArtifactRoutesOptions): void {
  app.get('/artifacts', async (req) => {
    await ensureArtifactStore();
    const query = req.query as {
      limit?: string;
      nodeId?: string;
      sessionId?: string;
      taskRunId?: string;
      includeDeleted?: string;
    };
    return await listArtifacts({
      limit: normalizePositiveInteger(query.limit),
      nodeId: normalizeOptionalString(query.nodeId),
      sessionId: normalizeOptionalString(query.sessionId),
      taskRunId: normalizeOptionalString(query.taskRunId),
      includeDeleted: query.includeDeleted === 'true',
    });
  });

  app.post('/artifacts', async (req, reply) => {
    const body = req.body as PutArtifactBody | undefined;
    const nodeId = normalizeOptionalString(body?.nodeId);
    const content = normalizeContent(body);
    if (!nodeId) return reply.status(422).send({ error: 'nodeId is required' });
    if (!content) return reply.status(422).send({ error: 'content is required' });

    const context = getRequestContext(req);
    const artifact = await putArtifact({
      artifactId: normalizeOptionalString(body?.artifactId),
      nodeId,
      sessionId: normalizeOptionalString(body?.sessionId),
      taskRunId: normalizeOptionalString(body?.taskRunId),
      traceId: normalizeOptionalString(body?.traceId) ?? context.traceId,
      requestId: normalizeOptionalString(body?.requestId) ?? context.requestId,
      workspaceRoot: normalizeOptionalString(body?.workspaceRoot),
      path: normalizeOptionalString(body?.path),
      pathPolicy: normalizePathPolicy(body?.pathPolicy),
      content,
      contentType: normalizeOptionalString(body?.contentType),
      metadata: normalizeJsonObject(body?.metadata),
      storageRoot: options.storageRoot,
    });
    return reply.status(201).send({ ok: true, artifact });
  });

  app.get('/artifacts/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const artifact = await loadArtifact(id);
    if (!artifact) return reply.status(404).send({ error: 'artifact not found' });
    return artifact;
  });

  app.get('/artifacts/:id/content', async (req, reply) => {
    const { id } = req.params as { id: string };
    const artifact = await readArtifactContent(id);
    if (!artifact) return reply.status(404).send({ error: 'artifact not found' });
    return reply
      .type(artifact.record.contentType)
      .header('X-Artifact-Id', artifact.record.artifactId)
      .header('X-Artifact-Checksum', artifact.record.checksum)
      .send(artifact.content);
  });

  app.delete('/artifacts/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = req.body as { reason?: string } | undefined;
    const artifact = await deleteArtifact(id, normalizeOptionalString(body?.reason));
    if (!artifact) return reply.status(404).send({ error: 'artifact not found' });
    return { ok: true, artifact };
  });
}

function normalizeContent(body: PutArtifactBody | undefined): Buffer | null {
  if (typeof body?.content !== 'string') return null;
  if (body.encoding === 'base64') return Buffer.from(body.content, 'base64');
  return Buffer.from(body.content, 'utf-8');
}

function normalizePathPolicy(value: unknown): ArtifactPathPolicy | undefined {
  if (value === 'workspace-relative' || value === 'artifact-store' || value === 'read-only-export') return value;
  return undefined;
}

function normalizeJsonObject(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  return undefined;
}

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function normalizePositiveInteger(value: unknown): number | undefined {
  const raw = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  if (!Number.isFinite(raw)) return undefined;
  const int = Math.floor(raw);
  return int > 0 ? int : undefined;
}
