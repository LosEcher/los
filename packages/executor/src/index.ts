import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import executorPackage from '../package.json' with { type: 'json' };
import { loadConfig, getMigrateDir } from '@los/infra/config';
import { initDb, getDb } from '@los/infra/db';
import { migrateDir } from '@los/infra/migrate';
import { getLogger } from '@los/infra/logger';
import {
  heartbeatAgentTask,
  heartbeatTaskRun,
  resolveIdentityLevelForExecutionPath,
  runAgent,
  type AgentConfig,
  type AgentModelDelta,
  type ExecutorNodeConnectMode,
  type ExecutorNodeKind,
  type SessionEventRecord,
  type ToolCallStateTransition,
} from '@los/agent';
import { ensureAllAgentStores } from '@los/agent/ensure-all-stores';
import { startPeriodicSync, createFileSyncStore } from './file-sync/index.js';
import { createExecutorNodeCommandRuntime } from './node-command-runner.js';
import { handleFileSyncRoute } from './file-sync-routes.js';
import { handleArtifactRoute, handleNodeCommandRoute } from './executor-routes.js';
import { _renewTaskLease } from './lease-fencing.js';
import { heartbeatNode } from './executor-heartbeat.js';
import { ExecutorRuntimeLifecycle, shutdownExecutor } from './runtime-lifecycle.js';
import {
  acceptsNdjson,
  normalizeLeaseMs,
  normalizeOptionalString,
  normalizePositiveInteger,
  normalizeRequiredString,
  readJson,
  sendJson,
} from './executor-helpers.js';

const log = getLogger('executor');
const DEFAULT_LEASE_MS = 30_000;
const DEFAULT_HEARTBEAT_MS = 10_000;

interface RunAgentRequest {
  taskRunId: string;
  nodeId?: string;
  leaseVersion?: number;
  agentTaskLease?: { taskId: string; leaseVersion: number };
  leaseMs?: number;
  prompt: string;
  config?: Omit<AgentConfig, 'signal' | 'onSessionEvent' | 'onProviderFallback' | 'onTurn' | 'onToolCall' | 'onToolCallState' | 'onModelDelta' | 'onCheckpoint'>;
}

type ExecutorStreamChunk =
  | { type: 'session_event'; event: SessionEventRecord }
  | { type: 'model_delta'; delta: AgentModelDelta }
  | { type: 'tool_call_state'; transition: ToolCallStateTransition }
  | { type: 'result'; result: unknown }
  | { type: 'error'; error: string };

export async function startExecutor() {
  const config = await loadConfig();
  const host = config.executor.host;
  const port = config.executor.port;
  const gatewayUrl = config.executor.gatewayUrl;
  const version = config.executor.version ?? config.server.version ?? executorPackage.version;
  const heartbeatViaApi = !!gatewayUrl;
  const shutdownGraceMs = config.executor.shutdownGraceMs;
  const lifecycle = new ExecutorRuntimeLifecycle();

  await initDb(config.databaseUrl);

  // Run ordered migrations before ensureAllStores. Executor nodes (especially
  // remote ones with their own DB) must not rely on the gateway's
  // ensureAllStores — file_sync_* tables have no ensure*Store, so migration is
  // their only source. Idempotent; mirrors gateway startup. See
  // packages/gateway/src/server.ts and docs/architecture/2026-06-28-self-iteration-engineering.md.
  const migrateResult = await migrateDir(getMigrateDir(config), getDb());
  if (migrateResult.applied.length > 0) {
    log.info(`Executor migrations applied: ${migrateResult.applied.join(', ')}`);
  }
  if (migrateResult.errors.length > 0) {
    log.warn(`Executor migration errors: ${migrateResult.errors.join('; ')}`);
  }

  // ensureAllAgentStores covers ALL agent-owned tables (27 stores).
  // This closes the bootstrap blind spot: remote executor nodes previously
  // only ensured 3 tables (executor_node, artifact, task_runs), leaving
  // 24 tables missing. Now remote nodes have a full schema just like the
  // gateway, which is necessary because runAgent() touches run_specs,
  // session_events, tool_call_states, verification_records, etc.
  await ensureAllAgentStores();

  const nodeId = config.executor.nodeId ?? `node-${randomUUID()}`;
  const publicUrl = config.executor.nodeUrl ?? `http://${host}:${port}`;
  const nodeKind: ExecutorNodeKind = (config.executor.nodeKind as ExecutorNodeKind) ?? 'executor';
  const baseConnectModes: ExecutorNodeConnectMode[] = ['agent_http', 'agent_http_ndjson'];
  const connectModes: ExecutorNodeConnectMode[] = [
    ...new Set([...baseConnectModes, ...(config.executor.connectModes as ExecutorNodeConnectMode[] ?? [])]),
  ];
  const agentKey = config.executor.agentKey ?? (() => {
    const generated = `los-key-${randomUUID()}`;
    log.warn(`No EXECUTOR_AGENT_KEY configured. Generated ephemeral key: ${generated}`);
    log.warn('Set EXECUTOR_AGENT_KEY in .env (same value for gateway and executor) to use a persistent key.');
    return generated;
  })();
  const artifactStorageRoot = executorArtifactStorageRoot(nodeId, config.executor.artifactRoot);
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
  heartbeatNode(nodeId, publicUrl, version, nodeKind, connectModes, lifecycle, gatewayUrl, await resolveFileSyncFolders()).catch((err) => log.warn(`initial heartbeat failed (will retry): ${err.message ?? String(err)}`));
  const nodeHeartbeat = setInterval(() => {
    resolveFileSyncFolders().then(folders =>
      heartbeatNode(nodeId, publicUrl, version, nodeKind, connectModes, lifecycle, gatewayUrl, folders).catch((err) => log.warn(`node heartbeat failed: ${err.message ?? String(err)}`))
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
          version,
          nodeKind,
          connectModes,
          lifecycle: lifecycle.status,
          acceptingTasks: lifecycle.acceptingTasks,
          activeTaskCount: lifecycle.activeTaskCount,
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
        const activeTask = lifecycle.startTask();
        if (!activeTask) {
          sendJson(res, 503, { error: 'executor_draining', retryable: true });
          return;
        }
        try {
          const body = await readJson<RunAgentRequest>(req);
          if (acceptsNdjson(req)) {
            await streamAssignedAgentTask(res, body, nodeId, activeTask.controller);
            return;
          }
          const result = await runAssignedAgentTask(body, nodeId, undefined, activeTask.controller);
          sendJson(res, 200, result);
          return;
        } finally {
          activeTask.finish();
        }
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
  log.info(`Executor node ${nodeId} listening on ${publicUrl}`);

  // Start periodic file-sync scanning for folders registered on this node
  const stopPeriodicSync = startPeriodicSync(nodeId);
  let shutdownPromise: Promise<void> | undefined;
  const shutdown = () => shutdownPromise ??= shutdownExecutor({
    server,
    lifecycle,
    shutdownGraceMs,
    stopHeartbeat: () => clearInterval(nodeHeartbeat),
    stopPeriodicSync,
    writeHeartbeat: async () => heartbeatNode(
      nodeId,
      publicUrl,
      version,
      nodeKind,
      connectModes,
      lifecycle,
      gatewayUrl,
      await resolveFileSyncFolders(),
    ),
  });

  return { server, lifecycle, shutdown };
}

async function streamAssignedAgentTask(
  res: ServerResponse,
  body: RunAgentRequest,
  nodeId: string,
  controller: AbortController,
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
    await runAssignedAgentTask(body, nodeId, emit, controller);
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
  controller = new AbortController(),
) {
  const taskRunId = normalizeRequiredString(body.taskRunId, 'taskRunId');
  const prompt = normalizeRequiredString(body.prompt, 'prompt');
  const nodeId = normalizeOptionalString(body.nodeId) ?? defaultNodeId;
  const leaseVersion = Math.max(1, Math.floor(Number(body.leaseVersion ?? 0)));
  if (!Number.isFinite(leaseVersion) || leaseVersion < 1) {
    throw new Error('leaseVersion must be a positive integer');
  }
  const leaseMs = normalizeLeaseMs(body.leaseMs, DEFAULT_LEASE_MS);
  const events: SessionEventRecord[] = [];
  const deltas: AgentModelDelta[] = [];
  const toolCallStates: ToolCallStateTransition[] = [];

  const heartbeat = setInterval(() => {
    _renewTaskLease(taskRunId, nodeId, leaseVersion, body.agentTaskLease, leaseMs, controller).catch((err) => {
      log.warn(`task lease heartbeat failed: ${err.message ?? String(err)}`);
    });
  }, Math.max(1_000, Math.floor(leaseMs / 3)));

  try {
    const [initialTaskRunLease, initialAgentTaskLease] = await Promise.all([
      heartbeatTaskRun(taskRunId, { nodeId, leaseVersion, leaseMs }),
      body.agentTaskLease
        ? heartbeatAgentTask(body.agentTaskLease.taskId, {
            nodeId,
            leaseVersion: body.agentTaskLease.leaseVersion,
            leaseMs,
          })
        : Promise.resolve(true),
    ]);
    if (!initialTaskRunLease || !initialAgentTaskLease) {
      throw new Error(`execution lease lost before executor start for task run ${taskRunId}`);
    }
    const result = await runAgent(prompt, {
      ...(body.config ?? {}),
      identity: body.config?.identity ?? {
        name: 'default',
        level: resolveIdentityLevelForExecutionPath('remote-executor'),
      },
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

function isAuthorized(req: IncomingMessage, agentKey: string | undefined): boolean {
  if (!agentKey) return false;
  return req.headers.authorization === `Bearer ${agentKey}`;
}

function executorArtifactStorageRoot(nodeId: string, artifactRoot?: string): string {
  if (artifactRoot) return resolve(artifactRoot);
  return resolve(process.cwd(), '.los-runtime', 'executor-artifacts', encodeURIComponent(nodeId));
}

let activeExecutor: Awaited<ReturnType<typeof startExecutor>> | undefined;
let shutdownRequested = false;

import { pathToFileURL } from 'node:url';

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  startExecutor().then((executor) => {
    activeExecutor = executor;
    if (shutdownRequested) shutdown();
  }).catch((err) => {
    console.error(err);
    process.exit(1);
  });

  const shutdown = () => {
    shutdownRequested = true;
    if (!activeExecutor) {
      return;
    }
    activeExecutor.shutdown().then(() => process.exit(0)).catch((err) => {
      console.error(err);
      process.exit(1);
    });
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}
