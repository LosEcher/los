import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  deleteArtifact,
  executeNodeCommand,
  listArtifacts,
  loadArtifact,
  putArtifact,
  readArtifactContent,
  type ArtifactPathPolicy,
  type NodeCommandName,
} from '@los/agent';
import { createExecutorNodeCommandRuntime } from './node-command-runner.js';
import type { NodeCommandRuntime } from '@los/agent';
import {
  normalizeOptionalString,
  normalizePositiveInteger,
  normalizeJsonObject,
  normalizePathPolicy,
  normalizeNodeCommand,
  readJson,
  sendJson,
} from './executor-helpers.js';

type ReadJson = typeof readJson;
type NormalizeOptionalString = typeof normalizeOptionalString;
type NormalizePositiveInteger = typeof normalizePositiveInteger;
type SendJson = typeof sendJson;

interface PutExecutorArtifactRequest {
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
}

interface ExecutorNodeCommandRequest {
  command?: NodeCommandName;
  commandId?: string;
  requestedBy?: string;
  traceId?: string;
  targetVersion?: string;
  timeoutMs?: number;
  reason?: string;
  args?: Record<string, unknown>;
}

export async function handleArtifactRoute(
  req: IncomingMessage,
  res: ServerResponse,
  route: URL,
  nodeId: string,
  storageRoot: string,
): Promise<void> {
  const artifactMatch = route.pathname.match(/^\/v1\/artifacts\/([^/]+)(\/content)?$/);

  if (req.method === 'GET' && route.pathname === '/v1/artifacts') {
    const artifacts = await listArtifacts({
      nodeId,
      sessionId: normalizeOptionalString(route.searchParams.get('sessionId')),
      taskRunId: normalizeOptionalString(route.searchParams.get('taskRunId')),
      limit: normalizePositiveInteger(route.searchParams.get('limit')),
      includeDeleted: route.searchParams.get('includeDeleted') === 'true',
    });
    sendJson(res, 200, artifacts);
    return;
  }

  if (req.method === 'POST' && route.pathname === '/v1/artifacts') {
    const body = await readJson<PutExecutorArtifactRequest>(req);
    const requestedNodeId = normalizeOptionalString(body.nodeId);
    if (requestedNodeId && requestedNodeId !== nodeId) {
      sendJson(res, 409, { error: `executor artifact nodeId mismatch: ${requestedNodeId}` });
      return;
    }

    const content = normalizeArtifactContent(body);
    if (!content) {
      sendJson(res, 422, { error: 'content is required' });
      return;
    }

    const artifact = await putArtifact({
      artifactId: normalizeOptionalString(body.artifactId),
      nodeId,
      sessionId: normalizeOptionalString(body.sessionId),
      taskRunId: normalizeOptionalString(body.taskRunId),
      traceId: normalizeOptionalString(body.traceId),
      requestId: normalizeOptionalString(body.requestId),
      workspaceRoot: normalizeOptionalString(body.workspaceRoot),
      path: normalizeOptionalString(body.path),
      pathPolicy: normalizePathPolicy(body.pathPolicy),
      content,
      contentType: normalizeOptionalString(body.contentType),
      metadata: normalizeJsonObject(body.metadata),
      storageRoot,
    });
    sendJson(res, 201, { ok: true, artifact });
    return;
  }

  if (artifactMatch && req.method === 'GET' && artifactMatch[2] === '/content') {
    const artifactId = decodeURIComponent(artifactMatch[1]);
    const existing = await loadArtifact(artifactId);
    if (!existing || existing.nodeId !== nodeId) {
      sendJson(res, 404, { error: 'artifact not found' });
      return;
    }
    const artifact = await readArtifactContent(artifactId);
    if (!artifact) {
      sendJson(res, 404, { error: 'artifact not found' });
      return;
    }
    res.writeHead(200, {
      'Content-Type': artifact.record.contentType,
      'X-Artifact-Id': artifact.record.artifactId,
      'X-Artifact-Checksum': artifact.record.checksum,
    });
    res.end(artifact.content);
    return;
  }

  if (artifactMatch && req.method === 'GET') {
    const artifactId = decodeURIComponent(artifactMatch[1]);
    const artifact = await loadArtifact(artifactId);
    if (!artifact || artifact.nodeId !== nodeId) {
      sendJson(res, 404, { error: 'artifact not found' });
      return;
    }
    sendJson(res, 200, artifact);
    return;
  }

  if (artifactMatch && req.method === 'DELETE') {
    const artifactId = decodeURIComponent(artifactMatch[1]);
    const existing = await loadArtifact(artifactId);
    if (!existing || existing.nodeId !== nodeId) {
      sendJson(res, 404, { error: 'artifact not found' });
      return;
    }
    const body = await readJson<{ reason?: string }>(req);
    const artifact = await deleteArtifact(artifactId, normalizeOptionalString(body.reason));
    sendJson(res, 200, { ok: true, artifact });
    return;
  }

  sendJson(res, 404, { error: 'not found' });
}

export async function handleNodeCommandRoute(
  req: IncomingMessage,
  res: ServerResponse,
  route: URL,
  nodeId: string,
  runtime: NodeCommandRuntime = createExecutorNodeCommandRuntime(),
): Promise<void> {
  const match = route.pathname.match(/^\/v1\/nodes\/([^/]+)\/commands$/);
  if (!match) {
    sendJson(res, 404, { error: 'not found' });
    return;
  }

  const targetNodeId = decodeURIComponent(match[1]);
  if (targetNodeId !== nodeId) {
    sendJson(res, 409, { error: `node command target mismatch: ${targetNodeId}` });
    return;
  }
  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'method not allowed' });
    return;
  }

  const body = await readJson<ExecutorNodeCommandRequest>(req);
  const command = normalizeNodeCommand(body.command);
  if (!command) {
    sendJson(res, 422, { error: 'command is required' });
    return;
  }

  const record = await executeNodeCommand({
    commandId: normalizeOptionalString(body.commandId),
    nodeId,
    command,
    requestedBy: normalizeOptionalString(body.requestedBy),
    traceId: normalizeOptionalString(body.traceId),
    targetVersion: normalizeOptionalString(body.targetVersion),
    timeoutMs: normalizePositiveInteger(body.timeoutMs),
    reason: normalizeOptionalString(body.reason),
    args: normalizeJsonObject(body.args),
  }, runtime);
  const statusCode = record.status === 'failed' ? 500 : record.status === 'denied' ? 409 : 202;
  sendJson(res, statusCode, { ok: record.status !== 'failed' && record.status !== 'denied', command: record });
}

function normalizeArtifactContent(body: PutExecutorArtifactRequest): Buffer | null {
  if (typeof body.content !== 'string') return null;
  if (body.encoding === 'base64') return Buffer.from(body.content, 'base64');
  return Buffer.from(body.content, 'utf-8');
}
