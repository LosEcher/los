import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { loadConfig } from '@los/infra/config';
import { initDb } from '@los/infra/db';
import { getLogger } from '@los/infra/logger';
import {
  ensureArtifactStore,
  ensureExecutorNodeStore,
  heartbeatTaskRun,
  loadTaskRun,
  runAgent,
  type AgentConfig,
  type AgentModelDelta,
  type ExecutorNodeConnectMode,
  type ExecutorNodeKind,
  type SessionEventRecord,
  type ToolCallStateTransition,
} from '@los/agent';
import { startPeriodicSync, createFileSyncStore } from './file-sync/index.js';
import { createExecutorNodeCommandRuntime } from './node-command-runner.js';
import { handleFileSyncRoute } from './file-sync-routes.js';
import { collectResourceMetrics, resolveResourceCapabilities } from './resource-metrics.js';
import { handleArtifactRoute, handleNodeCommandRoute } from './executor-routes.js';
import {
  acceptsNdjson,
  createAbortError,
  normalizeLeaseMs,
  normalizeOptionalString,
  normalizePositiveInteger,
  normalizeRequiredString,
  readJson,
  readPort,
  sendJson,
} from './executor-helpers.js';

const log = getLogger('executor');
const VERSION = '0.1.0';
const DEFAULT_LEASE_MS = 30_000;
const DEFAULT_HEARTBEAT_MS = 10_000;

interface RunAgentRequest {
  taskRunId: string;
  nodeId?: string;
  leaseMs?: number;
  prompt: string;
  config?: Omit<AgentConfig, 'signal' | 'onSessionEvent' | 'onTurn' | 'onToolCall' | 'onToolCallState' | 'onModelDelta' | 'onCheckpoint'>;
}

type ExecutorStreamChunk =
  | { type: 'session_event'; event: SessionEventRecord }
  | { type: 'model_delta'; delta: AgentModelDelta }
  | { type: 'tool_call_state'; transition: ToolCallStateTransition }
  | { type: 'result'; result: unknown }
  | { type: 'error'; error: string };

export async function startExecutor(port = readPort(), host = process.env.EXECUTOR_HOST ?? '127.0.0.1') {
  const config = await loadConfig();
  const gatewayUrl = process.env.GATEWAY_URL;
  const heartbeatViaApi = !!gatewayUrl;

  await initDb(config.databaseUrl);
  await ensureExecutorNodeStore();
  await ensureArtifactStore();

  const nodeId = config.executor.nodeId ?? process.env.EXECUTOR_NODE_ID ?? `node-${randomUUID()}`;
  const publicUrl = config.executor.nodeUrl ?? process.env.EXECUTOR_NODE_URL ?? `http://${host}:${port}`;
  const nodeKind: ExecutorNodeKind = (config.executor.nodeKind as ExecutorNodeKind) ?? 'executor';
  const baseConnectModes: ExecutorNodeConnectMode[] = ['agent_http', 'agent_http_ndjson'];
  const connectModes: ExecutorNodeConnectMode[] = [...baseConnectModes, ...(config.executor.connectModes as ExecutorNodeConnectMode[] ?? [])];
  const agentKey = config.executor.agentKey ?? (() => {
    const generated = `los-key-${randomUUID()}`;
    log.warn(`No EXECUTOR_AGENT_KEY configured. Generated ephemeral key: ${generated}`);
    log.warn('Set EXECUTOR_AGENT_KEY in .env (same value for gateway and executor) to use a persistent key.');
    return generated;
  })();
  const artifactStorageRoot = executorArtifactStorageRoot(nodeId);
  const nodeCommandRuntime = createExecutorNodeCommandRuntime();
  const fileSyncStore = createFileSyncStore();

  if (!heartbeatViaApi) {
    log.info('GATEWAY_URL not set — will heartbeat directly to database');
  } else {
    log.info(`Executing node heartbeat via gateway: ${gatewayUrl}/nodes/heartbeat`);
  }

  // Resolve active file-sync folders for heartbeat capability reporting
  const resolveFileSyncFolders = async () => {
    try {
      const folders = await fileSyncStore.listFolders(nodeId);
      return folders
        .filter(f => f.status === 'active')
        .map(f => ({ name: f.name, localPath: f.localPath, mode: 'incremental' as const }));
    } catch {
      return [];
    }
  };

  // Fire initial heartbeat without blocking server startup.
  // If the gateway is temporarily unreachable the server still starts,
  // and the interval below will retry every heartbeat interval.
  heartbeatNode(nodeId, publicUrl, nodeKind, connectModes, gatewayUrl, await resolveFileSyncFolders()).catch((err) => log.warn(`initial heartbeat failed (will retry): ${err.message ?? String(err)}`));
  const nodeHeartbeat = setInterval(() => {
    resolveFileSyncFolders().then(folders =>
      heartbeatNode(nodeId, publicUrl, nodeKind, connectModes, gatewayUrl, folders).catch((err) => log.warn(`node heartbeat failed: ${err.message ?? String(err)}`))
    );
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
          nodeKind,
          connectModes,
        });
        return;
      }

      if (route.pathname.startsWith('/v1/artifacts')) {
        if (!isAuthorized(req, agentKey)) { sendJson(res, 401, { error: 'unauthorized' }); return; }
        await handleArtifactRoute(req, res, route, nodeId, artifactStorageRoot);
        return;
      }

      if (route.pathname.startsWith('/v1/nodes/') && route.pathname.endsWith('/commands')) {
        if (!isAuthorized(req, agentKey)) { sendJson(res, 401, { error: 'unauthorized' }); return; }
        await handleNodeCommandRoute(req, res, route, nodeId, nodeCommandRuntime);
        return;
      }

      if (req.method === 'POST' && route.pathname === '/v1/tasks/run-agent') {
        if (!isAuthorized(req, agentKey)) { sendJson(res, 401, { error: 'unauthorized' }); return; }
        const body = await readJson<RunAgentRequest>(req);
        if (acceptsNdjson(req)) {
          await streamAssignedAgentTask(res, body, nodeId);
          return;
        }
        const result = await runAssignedAgentTask(body, nodeId);
        sendJson(res, 200, result);
        return;
      }

      if (route.pathname.startsWith('/v1/file-sync')) {
        if (!isAuthorized(req, agentKey)) { sendJson(res, 401, { error: 'unauthorized' }); return; }
        await handleFileSyncRoute(req, res, route, nodeId, readJson, normalizeOptionalString, normalizePositiveInteger, sendJson);
        return;
      }

      sendJson(res, 404, { error: 'not found' });
    } catch (err: any) {
      sendJson(res, 500, { error: err?.message ?? String(err) });
    }
  });

  await new Promise<void>((resolve) => server.listen(port, host, resolve));
  server.on('close', () => {
    clearInterval(nodeHeartbeat);
    stopPeriodicSync();
  });
  log.info(`Executor node ${nodeId} listening on ${publicUrl}`);

  // Start periodic file-sync scanning for folders registered on this node
  const stopPeriodicSync = startPeriodicSync(nodeId);

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
  const leaseMs = normalizeLeaseMs(body.leaseMs, DEFAULT_LEASE_MS);
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

async function heartbeatNode(
  nodeId: string,
  baseUrl: string,
  nodeKind: ExecutorNodeKind,
  connectModes: ExecutorNodeConnectMode[],
  gatewayUrl?: string,
  fileSyncFolders?: Array<{ name: string; localPath: string; mode?: string }>,
): Promise<void> {
  const capabilities: Record<string, unknown> = {
    run_agent: true,
    stream_ndjson: true,
    task_lease: true,
    workspace_read: true,
    workspace_write: true,
    artifact_transfer: true,
    node_command_runner: true,
    file_sync_scan: true,
    file_sync_deep_verify: true,
    shell: true,
    sandbox: 'tool_policy',
    ...resolveResourceCapabilities(),
  };
  if (fileSyncFolders && fileSyncFolders.length > 0) {
    capabilities.file_sync_folders = fileSyncFolders.map(f => ({
      name: f.name,
      folder: f.name,
      path: f.localPath,
      mode: f.mode ?? 'incremental',
    }));
  }

  const payload = {
    nodeId,
    baseUrl,
    hostLabel: hostname(),
    version: VERSION,
    nodeKind,
    connectModes,
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
      ...collectResourceMetrics(),
    },
    capabilities,
    queueDepth: 0,
    activeTaskCount: 0,
  };

  if (gatewayUrl) {
    const res = await fetch(`${gatewayUrl}/nodes/heartbeat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      throw new Error(`gateway heartbeat returned ${res.status}: ${await res.text()}`);
    }
  } else {
    const { upsertExecutorNodeHeartbeat } = await import('@los/agent');
    await upsertExecutorNodeHeartbeat(payload);
  }
}

function isAuthorized(req: IncomingMessage, agentKey: string | undefined): boolean {
  if (!agentKey) return false;
  return req.headers.authorization === `Bearer ${agentKey}`;
}

function executorArtifactStorageRoot(nodeId: string): string {
  const configured = process.env.EXECUTOR_ARTIFACT_ROOT ?? process.env.LOS_EXECUTOR_ARTIFACT_ROOT;
  if (configured) return resolve(configured);
  return resolve(process.cwd(), '.los-runtime', 'executor-artifacts', encodeURIComponent(nodeId));
}

let activeServer: Awaited<ReturnType<typeof startExecutor>> | undefined;

import { pathToFileURL } from 'node:url';

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
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
