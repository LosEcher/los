import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { loadConfig } from '@los/infra/config';
import { initDb } from '@los/infra/db';
import { getLogger } from '@los/infra/logger';
import {
  deleteArtifact,
  ensureArtifactStore,
  ensureExecutorNodeStore,
  heartbeatTaskRun,
  listArtifacts,
  loadArtifact,
  loadTaskRun,
  putArtifact,
  readArtifactContent,
  runAgent,
  executeNodeCommand,
  upsertExecutorNodeHeartbeat,
  type AgentConfig,
  type AgentModelDelta,
  type ArtifactPathPolicy,
  type NodeCommandName,
  type SessionEventRecord,
  type ToolCallStateTransition,
} from '@los/agent';
import { createExecutorNodeCommandRuntime } from './node-command-runner.js';

const log = getLogger('executor');
const VERSION = '0.1.0';
const DEFAULT_PORT = 8090;
const DEFAULT_LEASE_MS = 30_000;
const DEFAULT_HEARTBEAT_MS = 10_000;

interface RunAgentRequest {
  taskRunId: string;
  nodeId?: string;
  leaseMs?: number;
  prompt: string;
  config?: Omit<AgentConfig, 'signal' | 'onSessionEvent' | 'onTurn' | 'onToolCall' | 'onToolCallState' | 'onModelDelta' | 'onCheckpoint'>;
}

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

type ExecutorStreamChunk =
  | { type: 'session_event'; event: SessionEventRecord }
  | { type: 'model_delta'; delta: AgentModelDelta }
  | { type: 'tool_call_state'; transition: ToolCallStateTransition }
  | { type: 'result'; result: unknown }
  | { type: 'error'; error: string };

export async function startExecutor(port = readPort(), host = process.env.EXECUTOR_HOST ?? '127.0.0.1') {
  const config = await loadConfig();
  await initDb(config.databaseUrl);
  await ensureExecutorNodeStore();
  await ensureArtifactStore();

  const nodeId = config.executor.nodeId ?? process.env.EXECUTOR_NODE_ID ?? `node-${randomUUID()}`;
  const publicUrl = config.executor.nodeUrl ?? process.env.EXECUTOR_NODE_URL ?? `http://${host}:${port}`;
  const agentKey = config.executor.agentKey;
  const artifactStorageRoot = executorArtifactStorageRoot(nodeId);
  const nodeCommandRuntime = createExecutorNodeCommandRuntime();

  await heartbeatNode(nodeId, publicUrl);
  const nodeHeartbeat = setInterval(() => {
    heartbeatNode(nodeId, publicUrl).catch((err) => log.warn(`node heartbeat failed: ${err.message ?? String(err)}`));
  }, DEFAULT_HEARTBEAT_MS);

  const server = createServer(async (req, res) => {
    try {
      const route = new URL(req.url ?? '/', publicUrl);
      if (req.method === 'GET' && route.pathname === '/health') {
        sendJson(res, 200, {
          status: 'ok',
          nodeId,
          publicUrl,
          version: VERSION,
          nodeKind: 'executor',
          connectModes: ['agent_http', 'agent_http_ndjson'],
        });
        return;
      }

      if (route.pathname.startsWith('/v1/artifacts')) {
        if (!isAuthorized(req, agentKey)) {
          sendJson(res, 401, { error: 'unauthorized' });
          return;
        }
        await handleArtifactRoute(req, res, route, nodeId, artifactStorageRoot);
        return;
      }

      if (route.pathname.startsWith('/v1/nodes/') && route.pathname.endsWith('/commands')) {
        if (!isAuthorized(req, agentKey)) {
          sendJson(res, 401, { error: 'unauthorized' });
          return;
        }
        await handleNodeCommandRoute(req, res, route, nodeId, nodeCommandRuntime);
        return;
      }

      if (req.method === 'POST' && route.pathname === '/v1/tasks/run-agent') {
        if (!isAuthorized(req, agentKey)) {
          sendJson(res, 401, { error: 'unauthorized' });
          return;
        }
        const body = await readJson<RunAgentRequest>(req);
        if (acceptsNdjson(req)) {
          await streamAssignedAgentTask(res, body, nodeId);
          return;
        }
        const result = await runAssignedAgentTask(body, nodeId);
        sendJson(res, 200, result);
        return;
      }

      sendJson(res, 404, { error: 'not found' });
    } catch (err: any) {
      sendJson(res, 500, { error: err?.message ?? String(err) });
    }
  });

  await new Promise<void>((resolve) => server.listen(port, host, resolve));
  server.on('close', () => clearInterval(nodeHeartbeat));
  log.info(`Executor node ${nodeId} listening on ${publicUrl}`);
  return server;
}

async function handleArtifactRoute(
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
    const body = await readOptionalJson<{ reason?: string }>(req);
    const artifact = await deleteArtifact(artifactId, normalizeOptionalString(body.reason));
    sendJson(res, 200, { ok: true, artifact });
    return;
  }

  sendJson(res, 404, { error: 'not found' });
}

async function handleNodeCommandRoute(
  req: IncomingMessage,
  res: ServerResponse,
  route: URL,
  nodeId: string,
  runtime = createExecutorNodeCommandRuntime(),
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

async function streamAssignedAgentTask(
  res: ServerResponse,
  body: RunAgentRequest,
  nodeId: string,
): Promise<void> {
  res.writeHead(200, {
    'Content-Type': 'application/x-ndjson',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  const emit = (chunk: ExecutorStreamChunk) => {
    res.write(`${JSON.stringify(chunk)}\n`);
  };

  try {
    await runAssignedAgentTask(body, nodeId, emit);
  } catch (err: any) {
    emit({ type: 'error', error: err?.message ?? String(err) });
  } finally {
    res.end();
  }
}

async function runAssignedAgentTask(
  body: RunAgentRequest,
  defaultNodeId: string,
  emit?: (chunk: ExecutorStreamChunk) => void,
) {
  const taskRunId = normalizeRequiredString(body.taskRunId, 'taskRunId');
  const prompt = normalizeRequiredString(body.prompt, 'prompt');
  const nodeId = normalizeOptionalString(body.nodeId) ?? defaultNodeId;
  const leaseMs = normalizeLeaseMs(body.leaseMs);
  const events: SessionEventRecord[] = [];
  const deltas: AgentModelDelta[] = [];
  const toolCallStates: ToolCallStateTransition[] = [];

  const controller = new AbortController();
  const heartbeat = setInterval(() => {
    renewTaskLease(taskRunId, nodeId, leaseMs, controller).catch((err) => {
      log.warn(`task lease heartbeat failed: ${err.message ?? String(err)}`);
    });
  }, Math.max(1_000, Math.floor(leaseMs / 3)));

  try {
    await heartbeatTaskRun(taskRunId, { nodeId, leaseMs });
    const result = await runAgent(prompt, {
      ...(body.config ?? {}),
      signal: controller.signal,
      onSessionEvent: (event) => {
        events.push(event);
        emit?.({ type: 'session_event', event });
      },
      onModelDelta: (delta) => {
        deltas.push(delta);
        emit?.({ type: 'model_delta', delta });
      },
      onToolCallState: (transition) => {
        toolCallStates.push(transition);
        emit?.({ type: 'tool_call_state', transition });
      },
    });
    emit?.({ type: 'result', result });
    return { result, events, deltas, toolCallStates };
  } finally {
    clearInterval(heartbeat);
  }
}

function acceptsNdjson(req: IncomingMessage): boolean {
  const accept = req.headers.accept;
  const raw = Array.isArray(accept) ? accept.join(',') : accept ?? '';
  return raw.includes('application/x-ndjson');
}

async function renewTaskLease(
  taskRunId: string,
  nodeId: string,
  leaseMs: number,
  controller: AbortController,
): Promise<void> {
  const renewed = await heartbeatTaskRun(taskRunId, { nodeId, leaseMs });
  const taskRun = renewed ?? await loadTaskRun(taskRunId);
  if (taskRun?.status === 'cancelled' && !controller.signal.aborted) {
    controller.abort(createAbortError('cancelled_by_scheduler'));
  }
}

async function heartbeatNode(nodeId: string, baseUrl: string): Promise<void> {
  await upsertExecutorNodeHeartbeat({
    nodeId,
    baseUrl,
    hostLabel: hostname(),
    version: VERSION,
    nodeKind: 'executor',
    connectModes: ['agent_http', 'agent_http_ndjson'],
    connectConfig: {
      agent_http: {
        baseUrl,
        runAgentUrl: `${baseUrl}/v1/tasks/run-agent`,
        healthUrl: `${baseUrl}/health`,
        artifactsUrl: `${baseUrl}/v1/artifacts`,
        commandUrl: `${baseUrl}/v1/nodes/${nodeId}/commands`,
      },
    },
    capacity: {
      pid: process.pid,
      platform: process.platform,
      arch: process.arch,
    },
    capabilities: {
      run_agent: true,
      stream_ndjson: true,
      task_lease: true,
      workspace_read: true,
      workspace_write: true,
      artifact_transfer: true,
      node_command_runner: true,
      shell: true,
      sandbox: 'tool_policy',
    },
    queueDepth: 0,
    activeTaskCount: 0,
  });
}

function isAuthorized(req: IncomingMessage, agentKey: string | undefined): boolean {
  if (!agentKey) return true;
  return req.headers.authorization === `Bearer ${agentKey}`;
}

function executorArtifactStorageRoot(nodeId: string): string {
  const configured = process.env.EXECUTOR_ARTIFACT_ROOT ?? process.env.LOS_EXECUTOR_ARTIFACT_ROOT;
  if (configured) return resolve(configured);
  return resolve(process.cwd(), '.los-runtime', 'executor-artifacts', encodeURIComponent(nodeId));
}

function readJson<T>(req: IncomingMessage): Promise<T> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf-8').trim();
        resolve(JSON.parse(raw) as T);
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

function readOptionalJson<T extends Record<string, unknown>>(req: IncomingMessage): Promise<T> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf-8').trim();
        resolve((raw ? JSON.parse(raw) : {}) as T);
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function normalizeRequiredString(value: unknown, name: string): string {
  const normalized = normalizeOptionalString(value);
  if (!normalized) throw new Error(`${name} is required`);
  return normalized;
}

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function normalizeArtifactContent(body: PutExecutorArtifactRequest): Buffer | null {
  if (typeof body.content !== 'string') return null;
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

function normalizeNodeCommand(value: unknown): NodeCommandName | undefined {
  if (value === 'status' || value === 'probe' || value === 'drain' || value === 'promote' || value === 'restart' || value === 'upgrade' || value === 'rollback') {
    return value;
  }
  return undefined;
}

function normalizePositiveInteger(value: unknown): number | undefined {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  if (!Number.isFinite(parsed)) return undefined;
  const integer = Math.floor(parsed);
  return integer > 0 ? integer : undefined;
}

function normalizeLeaseMs(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_LEASE_MS;
  return Math.max(1_000, Math.min(Math.floor(value), 10 * 60_000));
}

function readPort(): number {
  const raw = Number(process.env.EXECUTOR_PORT ?? DEFAULT_PORT);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_PORT;
}

function createAbortError(reason: string): Error {
  const err = new Error(reason);
  err.name = 'AbortError';
  return err;
}

let activeServer: Awaited<ReturnType<typeof startExecutor>> | undefined;

if (import.meta.url === `file://${process.argv[1]}`) {
  startExecutor().then((server) => {
    activeServer = server;
  }).catch((err) => {
    console.error(err);
    process.exit(1);
  });

  const shutdown = () => {
    if (!activeServer) {
      process.exit(0);
    }
    activeServer.close(() => process.exit(0));
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}
