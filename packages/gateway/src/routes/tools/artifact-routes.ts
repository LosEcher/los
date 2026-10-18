import type { FastifyInstance } from 'fastify';
import { createHash } from 'node:crypto';
import {
  deleteArtifact,
  ensureArtifactStore,
  listArtifacts,
  loadArtifact,
  putArtifact,
  loadRemoteArtifactIndex,
  putRemoteArtifactIndex,
  deleteRemoteArtifactIndex,
  type RemoteArtifactIndexRecord,
  readArtifactContent,
  updateArtifactStatus,
  type ArtifactRecord,
  type ArtifactPathPolicy,
  type ArtifactStatus,
} from '@los/agent/artifacts';
import { loadExecutorNode } from '@los/agent/executor-nodes';
import { getRequestContext, requireOperator } from '../../request-context.js';

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
  confidence?: number;
  metadata?: Record<string, unknown>;
};

const ARTIFACT_BODY_LIMIT_BYTES = 32 * 1024 * 1024;

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

  app.post('/artifacts', { bodyLimit: ARTIFACT_BODY_LIMIT_BYTES }, async (req, reply) => {
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
      confidence: typeof body?.confidence === 'number' ? body.confidence : undefined,
      metadata: normalizeJsonObject(body?.metadata),
      storageRoot: options.storageRoot,
    });
    return reply.status(201).send({ ok: true, artifact });
  });

  /**
   * Push an existing gateway-held artifact to an executor and index the remote
   * copy in the gateway. The target executor already owns POST /v1/artifacts;
   * this route is the missing gateway→owner direction (read/delete already
   * existed). The returned record lets GET /artifacts/:id/content fetch the
   * remote bytes through the existing owner path.
   */
  app.post('/artifacts/:id/relay', async (req, reply) => {
    if (!(await requireOperator(req, reply))) return;
    const { id } = req.params as { id: string };
    const body = req.body as { nodeId?: unknown } | undefined;
    const targetNodeId = normalizeOptionalString(body?.nodeId);
    if (!targetNodeId) return reply.status(422).send({ error: 'nodeId is required' });

    const source = await loadArtifact(id) ?? await loadRemoteArtifactAsRecord(id);
    if (!source) return reply.status(404).send({ error: 'artifact not found' });

    const content = await readArtifactContentFromOwner(source, options.executorAgentKey);
    const artifactsUrl = await artifactOwnerUrl(targetNodeId);
    if (!artifactsUrl) {
      if (targetNodeId !== 'gateway-local') {
        return reply.status(404).send({ error: 'target executor not found' });
      }
      // Return direction: source lives on an executor, target is this gateway.
      // Use a new local id rather than overwriting the owner's shared-DB row.
      const local = await putArtifact({
        artifactId: `${source.artifactId}-gateway`,
        nodeId: targetNodeId,
        sessionId: source.sessionId,
        taskRunId: source.taskRunId,
        traceId: source.traceId,
        requestId: source.requestId,
        path: source.originalPath,
        pathPolicy: source.pathPolicy,
        content: content.content,
        contentType: source.contentType,
        metadata: { ...source.metadata, relayedFrom: source.nodeId },
        storageRoot: options.storageRoot,
      });
      return reply.status(201).send({ ok: true, artifact: local });
    }

    // Owner and gateway share the artifacts table; a distinct owner-side id
    // prevents the two index rows from overwriting each other.
    const remoteArtifactId = `${source.artifactId}-relay-${targetNodeId}`;
    const response = await fetch(artifactsUrl, {
      method: 'POST',
      headers: ownerHeaders(options.executorAgentKey),
      body: JSON.stringify({
        artifactId: remoteArtifactId,
        nodeId: targetNodeId,
        content: content.content.toString('base64'),
        encoding: 'base64',
        contentType: source.contentType,
        path: source.originalPath,
        pathPolicy: source.pathPolicy,
        metadata: { ...source.metadata, relayedFrom: source.nodeId },
      }),
    });
    const text = await response.text();
    const payload = text ? JSON.parse(text) as { artifact?: ArtifactRecord; error?: string } : {};
    if (!response.ok) {
      return reply.status(502).send({ error: `executor artifact relay failed: ${response.status} ${payload.error ?? text}` });
    }
    const remote = payload.artifact;
    if (!remote) return reply.status(502).send({ error: 'executor artifact relay returned no artifact' });
    if (remote.checksum !== content.checksum) {
      return reply.status(502).send({ error: `executor artifact checksum mismatch: ${remote.checksum}` });
    }
    const indexed = await putRemoteArtifactIndex({
      artifactId: source.artifactId,
      remoteArtifactId: remote.artifactId,
      nodeId: targetNodeId,
      sizeBytes: remote.sizeBytes,
      checksum: remote.checksum,
      contentType: remote.contentType,
      originalPath: remote.originalPath,
      pathPolicy: remote.pathPolicy,
      sessionId: source.sessionId,
      taskRunId: source.taskRunId,
      traceId: source.traceId,
      requestId: source.requestId,
      metadata: { ...source.metadata, relayedFrom: source.nodeId },
    });
    return reply.status(201).send({ ok: true, artifact: remoteIndexToArtifact(indexed), remote });
  });

  app.get('/artifacts/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const artifact = await loadArtifact(id) ?? await loadRemoteArtifactAsRecord(id);
    if (!artifact) return reply.status(404).send({ error: 'artifact not found' });
    return artifact;
  });

  app.get('/artifacts/:id/content', async (req, reply) => {
    const { id } = req.params as { id: string };
    const record = await loadArtifact(id) ?? await loadRemoteArtifactAsRecord(id);
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
    // Deleting a source must also delete its relayed owner copy; otherwise the
    // index resurrects the artifact through GET /artifacts/:id/content.
    const relayed = await loadRemoteArtifactAsRecord(id);
    if (!existing && !relayed) return reply.status(404).send({ error: 'artifact not found' });
    if (relayed) {
      await deleteArtifactFromOwner(relayed, normalizeOptionalString(body?.reason), options.executorAgentKey);
      await deleteRemoteArtifactIndex(id);
    }
    if (!existing) {
      return { ok: true, artifact: { ...relayed!, deletedAt: new Date().toISOString() } };
    }
    const remote = await deleteArtifactFromOwner(existing, normalizeOptionalString(body?.reason), options.executorAgentKey);
    if (remote) return remote;
    const artifact = await deleteArtifact(id, normalizeOptionalString(body?.reason));
    if (!artifact) return reply.status(404).send({ error: 'artifact not found' });
    return { ok: true, artifact, relayed: Boolean(relayed) };
  });

  // PATCH /artifacts/:id/status — update artifact confidence lifecycle.
  // 'confirmed' requires human attestation (operator-facing endpoint).
  // AI agents calling through the gateway are limited to agent-writable statuses.
  app.patch('/artifacts/:id/status', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = req.body as {
      status?: ArtifactStatus;
      confidence?: number;
      reason?: string;
      isHumanAttestation?: boolean;
    } | undefined;

    const existing = await loadArtifact(id);
    if (!existing) return reply.status(404).send({ error: 'artifact not found' });

    try {
      const artifact = await updateArtifactStatus(
        id,
        {
          status: normalizeArtifactStatusValue(body?.status),
          confidence: typeof body?.confidence === 'number' ? body.confidence : undefined,
          reason: normalizeOptionalString(body?.reason),
        },
        { isHumanAttestation: body?.isHumanAttestation === true },
      );
      return { ok: true, artifact };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes('requires human attestation') || message.includes('not writable by AI agents')) {
        return reply.status(403).send({ error: message });
      }
      throw err;
    }
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
  const ownerArtifactId = ownerArtifactIdFor(record);

  const response = await fetch(`${artifactsUrl}/${encodeURIComponent(ownerArtifactId)}`, {
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
  const ownerArtifactId = ownerArtifactIdFor(record);
  const response = await fetch(`${artifactsUrl}/${encodeURIComponent(ownerArtifactId)}/content`, {
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


async function loadRemoteArtifactAsRecord(artifactId: string): Promise<ArtifactRecord | null> {
  const remote = await loadRemoteArtifactIndex(artifactId);
  return remote ? remoteIndexToArtifact(remote) : null;
}

function remoteIndexToArtifact(remote: RemoteArtifactIndexRecord): ArtifactRecord {
  return {
    artifactId: remote.artifactId,
    nodeId: remote.nodeId,
    sessionId: remote.sessionId,
    taskRunId: remote.taskRunId,
    traceId: remote.traceId,
    requestId: remote.requestId,
    originalPath: remote.originalPath,
    pathPolicy: remote.pathPolicy,
    storagePath: `executor://${remote.nodeId}/${remote.remoteArtifactId}`,
    sizeBytes: remote.sizeBytes,
    checksum: remote.checksum,
    checksumAlgorithm: 'sha256',
    contentType: remote.contentType,
    status: 'draft',
    confidence: 0.5,
    metadata: { ...remote.metadata, remoteArtifactId: remote.remoteArtifactId },
    createdAt: remote.createdAt,
    updatedAt: remote.updatedAt,
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

function ownerArtifactIdFor(record: ArtifactRecord): string {
  const remote = record.metadata?.remoteArtifactId;
  return typeof remote === 'string' && remote ? remote : record.artifactId;
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

function normalizeArtifactStatusValue(value: unknown): ArtifactStatus | undefined {
  const VALID: ArtifactStatus[] = ['draft', 'candidate', 'reviewed', 'confirmed', 'rejected'];
  if (typeof value === 'string' && VALID.includes(value as ArtifactStatus)) {
    return value as ArtifactStatus;
  }
  return undefined;
}
