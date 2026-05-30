import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import { loadConfig } from '@los/infra/config';
import { initDb } from '@los/infra/db';
import { getLogger } from '@los/infra/logger';
import {
  ensureExecutorNodeStore,
  upsertExecutorNodeHeartbeat,
  heartbeatTaskRun,
  loadTaskRun,
  runAgent,
  type AgentConfig,
  type AgentModelDelta,
  type SessionEventRecord,
} from '@los/agent';

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
  config?: Omit<AgentConfig, 'signal' | 'onSessionEvent' | 'onTurn' | 'onToolCall'>;
}

type ExecutorStreamChunk =
  | { type: 'session_event'; event: SessionEventRecord }
  | { type: 'model_delta'; delta: AgentModelDelta }
  | { type: 'result'; result: unknown }
  | { type: 'error'; error: string };

export async function startExecutor(port = readPort(), host = process.env.EXECUTOR_HOST ?? '127.0.0.1') {
  const config = await loadConfig();
  await initDb(config.databaseUrl);
  await ensureExecutorNodeStore();

  const nodeId = config.executor.nodeId ?? process.env.EXECUTOR_NODE_ID ?? `node-${randomUUID()}`;
  const publicUrl = config.executor.nodeUrl ?? process.env.EXECUTOR_NODE_URL ?? `http://${host}:${port}`;
  const agentKey = config.executor.agentKey;

  await heartbeatNode(nodeId, publicUrl);
  const nodeHeartbeat = setInterval(() => {
    heartbeatNode(nodeId, publicUrl).catch((err) => log.warn(`node heartbeat failed: ${err.message ?? String(err)}`));
  }, DEFAULT_HEARTBEAT_MS);

  const server = createServer(async (req, res) => {
    try {
      if (req.method === 'GET' && req.url === '/health') {
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

      if (req.method === 'POST' && req.url === '/v1/tasks/run-agent') {
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
    });
    emit?.({ type: 'result', result });
    return { result, events, deltas };
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

function readJson<T>(req: IncomingMessage): Promise<T> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf-8')) as T);
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
