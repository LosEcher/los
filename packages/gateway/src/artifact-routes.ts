import type { FastifyInstance } from 'fastify';
import { createHash } from 'node:crypto';
import {
  deleteArtifact,
  ensureArtifactStore,
  listArtifacts,
  loadArtifact,
  putArtifact,
  readArtifactContent,
  type ArtifactRecord,
  type ArtifactPathPolicy,
} from '@los/agent/artifacts';
import { loadExecutorNode } from '@los/agent/executor-nodes';
import { getRequestContext } from './request-context.js';

type ArtifactRoutesOptions = {
  storageRoot: string;
  executorAgentKey?: string;
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
    const record = await loadArtifact(id);
    if (!record) return reply.status(404).send({ error: 'artifact not found' });
    const artifact = await readArtifactContentFromOwner(record, options.executorAgentKey);
    return reply
      .type(artifact.contentType)
      .header('X-Artifact-Id', record.artifactId)
      .header('X-Artifact-Checksum', artifact.checksum)
      .send(artifact.content);
  });

  app.delete('/artifacts/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = req.body as { reason?: string } | undefined;
    const existing = await loadArtifact(id);
    if (!existing) return reply.status(404).send({ error: 'artifact not found' });
    const remote = await deleteArtifactFromOwner(existing, normalizeOptionalString(body?.reason), options.executorAgentKey);
    if (remote) return remote;
    const artifact = await deleteArtifact(id, normalizeOptionalString(body?.reason));
    if (!artifact) return reply.status(404).send({ error: 'artifact not found' });
    return { ok: true, artifact };
  });
}

async function readArtifactContentFromOwner(
  record: ArtifactRecord,
  executorAgentKey: string | undefined,
): Promise<{ content: Buffer; contentType: string; checksum: string }> {
  const artifactsUrl = await artifactOwnerUrl(record.nodeId);
  if (artifactsUrl) {
    return await fetchOwnerArtifactContent(artifactsUrl, record, executorAgentKey);
  }

  const local = await readArtifactContent(record.artifactId);
  if (!local) throw new Error('artifact not found');
  return {
    content: local.content,
    contentType: local.record.contentType,
    checksum: local.record.checksum,
  };
}

async function deleteArtifactFromOwner(
  record: ArtifactRecord,
  reason: string | undefined,
  executorAgentKey: string | undefined,
): Promise<unknown | null> {
  const artifactsUrl = await artifactOwnerUrl(record.nodeId);
  if (!artifactsUrl) return null;

  const response = await fetch(`${artifactsUrl}/${encodeURIComponent(record.artifactId)}`, {
    method: 'DELETE',
    headers: ownerHeaders(executorAgentKey),
    body: JSON.stringify({ reason }),
  });
  if (response.status === 404) return null;
  const text = await response.text();
  const body = text ? JSON.parse(text) as unknown : {};
  if (!response.ok) {
    throw new Error(`executor artifact delete failed: ${response.status} ${response.statusText}: ${text}`);
  }
  return body;
}

async function fetchOwnerArtifactContent(
  artifactsUrl: string,
  record: ArtifactRecord,
  executorAgentKey: string | undefined,
): Promise<{ content: Buffer; contentType: string; checksum: string }> {
  const response = await fetch(`${artifactsUrl}/${encodeURIComponent(record.artifactId)}/content`, {
    headers: ownerHeaders(executorAgentKey),
  });
  if (!response.ok) {
    throw new Error(`executor artifact read failed: ${response.status} ${response.statusText}: ${await response.text()}`);
  }
  const content = Buffer.from(await response.arrayBuffer());
  const checksum = createHash('sha256').update(content).digest('hex');
  if (checksum !== record.checksum) {
    throw new Error(`artifact checksum mismatch: ${record.artifactId}`);
  }
  return {
    content,
    contentType: response.headers.get('content-type') ?? record.contentType,
    checksum,
  };
}

async function artifactOwnerUrl(nodeId: string): Promise<string | null> {
  const node = await loadExecutorNode(nodeId);
  const agentHttp = normalizeJsonObject(node?.connectConfig?.agent_http);
  const configured = normalizeOptionalString(agentHttp?.artifactsUrl);
  if (configured) return configured.replace(/\/+$/, '');
  const baseUrl = normalizeOptionalString(node?.baseUrl);
  return baseUrl ? `${baseUrl.replace(/\/+$/, '')}/v1/artifacts` : null;
}

function ownerHeaders(executorAgentKey: string | undefined): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (executorAgentKey) headers.Authorization = `Bearer ${executorAgentKey}`;
  return headers;
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
