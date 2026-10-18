import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import executorPackage from '../package.json' with { type: 'json' };
import { loadConfig, getMigrateDir } from '@los/infra/config';
import { initDb, getDb } from '@los/infra/db';
import { migrateDir } from '@los/infra/migrate';
import { getLogger } from '@los/infra/logger';
import {
  resolveIdentityLevelForExecutionPath,
  type AgentConfig,
  type AgentModelDelta,
  type ExecutorNodeConnectMode,
  type ExecutorNodeKind,
  type SessionEventRecord,
  type ToolCallStateTransition,
} from '@los/agent';
import { resolveExecutionKernel } from '@los/agent/execution-kernel-registry';
import { ensureAllAgentStores } from '@los/agent/ensure-all-stores';
import { startPeriodicSync, createFileSyncStore } from './file-sync/index.js';
import { createExecutorNodeCommandRuntime } from './node-command-runner.js';
import { handleFileSyncRoute } from './file-sync-routes.js';
import { handleArtifactRoute, handleNodeCommandRoute } from './executor-routes.js';
import { handleStatelessArtifactRoute } from './stateless-artifact-store.js';
import { GatewayEventSink, replayGatewayEventSpool } from './gateway-event-sink.js';
import {
  _renewAgentTaskLease,
  _renewTaskLease,
  _renewTaskRunLease,
  type TaskLeaseHttpTransport,
} from './lease-fencing.js';
import { heartbeatNode, resolveNodeVersion, type HeartbeatResponse } from './executor-heartbeat.js';
import { loadNodeCredential, rotateNodeCredentialViaGateway, saveNodeCredential } from './node-credential.js';
import { createHeartbeatReporter } from './executor-heartbeat-reporter.js';
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
interface RunAgentRequest {
  taskRunId: string;
  nodeId?: string;
  leaseVersion?: number;
  agentTaskLease?: { taskId: string; leaseVersion: number };
  leaseMs?: number;
  executionKernelKind?: string;
  prompt: string;
  /** Short-lived task token minted by the gateway. Never stored or logged. */
  taskToken?: string;
  config?: Omit<AgentConfig, 'signal' | 'onSessionEvent' | 'onProviderFallback' | 'onTurn' | 'onToolCall' | 'onToolCallState' | 'onModelDelta' | 'onCheckpoint'>;
}
type ExecutorStreamChunk =
  | { type: 'session_event'; event: SessionEventRecord }
  | { type: 'model_delta'; delta: AgentModelDelta }
  | { type: 'tool_call_state'; transition: ToolCallStateTransition }
  | { type: 'kernel_event'; kernelEvent: unknown }
  | { type: 'result'; result: unknown }
  | { type: 'error'; error: string };
export async function startExecutor() {
  const config = await loadConfig();
  const host = config.executor.host;
  const port = config.executor.port;
  const gatewayUrl = config.executor.gatewayUrl;
  const taskTokenMode = config.executor.taskTokenMode ?? 'auto';
  if (taskTokenMode === 'required' && !gatewayUrl) {
    throw new Error('EXECUTOR_TASK_TOKEN_MODE=required requires GATEWAY_URL for HTTP heartbeat');
  }
  // Content identity of this node, resolved once. `versionSource` rides along so
  // the gateway can count unpinned nodes without a new column
  // (docs/architecture/2026-10-10-control-plane-truth-remediation.md §1).
  const { version, versionSource } = resolveNodeVersion({
    executorVersion: config.executor.version,
    serverVersion: config.server.version,
    packageVersion: executorPackage.version,
  });
  const heartbeatViaApi = !!gatewayUrl;
  const shutdownGraceMs = config.executor.shutdownGraceMs;
  const lifecycle = new ExecutorRuntimeLifecycle();
  const dbDisabled = config.executor.dbMode === 'none';
  if (dbDisabled) {
    if (!gatewayUrl) throw new Error('EXECUTOR_DB_MODE=none requires GATEWAY_URL');
    if (taskTokenMode !== 'required') {
      throw new Error('EXECUTOR_DB_MODE=none requires EXECUTOR_TASK_TOKEN_MODE=required');
    }
    log.info('EXECUTOR_DB_MODE=none: skipping DB bootstrap, migrations, agent stores, and file-sync');
  } else {
    await initDb(config.databaseUrl);
  }
  // Run ordered migrations before ensureAllStores. Executor nodes (especially
  // remote ones with their own DB) must not rely on the gateway's
  // ensureAllStores — file_sync_* tables have no ensure*Store, so migration is
  // their only source. Idempotent; mirrors gateway startup. See
  // packages/gateway/src/server.ts and docs/architecture/2026-06-28-self-iteration-engineering.md.
  if (!dbDisabled) {
    const migrateResult = await migrateDir(getMigrateDir(config), getDb());
    if (migrateResult.applied.length > 0) {
      log.info(`Executor migrations applied: ${migrateResult.applied.join(', ')}`);
    }
    if (migrateResult.errors.length > 0) {
      log.warn(`Executor migration errors: ${migrateResult.errors.join('; ')}`);
    }
  }
  // ensureAllAgentStores covers ALL agent-owned tables (27 stores).
  // This closes the bootstrap blind spot: remote executor nodes previously
  // only ensured 3 tables (executor_node, artifact, task_runs), leaving
  // 24 tables missing. Now remote nodes have a full schema just like the
  // gateway, which is necessary because runAgent() touches run_specs,
  // session_events, tool_call_states, verification_records, etc.
  if (!dbDisabled) await ensureAllAgentStores();
  const nodeId = config.executor.nodeId ?? `node-${randomUUID()}`;
  executorEventSpoolRoot = resolve(process.cwd(), '.los-runtime', 'executor-events', encodeURIComponent(nodeId));
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
  // Per-node credential (ADR 0048 B3). Absent until the node is enrolled; the gateway
  // verifies it when present and still accepts heartbeats without it.
  // 状态文件优先：轮换过的新值落在这里（`.los-runtime/executor/`，0600），
  // 不能只靠 .env —— 否则重启会退回旧值，而旧值可能已经过了重叠窗口。
  let nodeCredential = loadNodeCredential(nodeId, config.executor.nodeCredential);
  if (dbDisabled && nodeCredential) {
    void replayGatewayEventSpool({
      spoolRoot: executorEventSpoolRoot,
      gatewayUrl: gatewayUrl!,
      nodeCredential,
      nodeId,
    }).then(sent => { if (sent > 0) log.info(`replayed ${sent} spooled event(s)`); })
      .catch(err => log.warn(`event spool replay failed: ${err?.message ?? String(err)}`));
  }
  let rotationInFlight = false;
  /** 轮换成功但落盘失败的新值；下一次心跳先补写。 */
  let pendingCredentialPersist: { credential: string; expiresAt?: string } | undefined;
  const nodeCommandRuntime = createExecutorNodeCommandRuntime();
  const fileSyncStore = createFileSyncStore();

  if (!heartbeatViaApi) {
    log.info('GATEWAY_URL not set — will heartbeat directly to database');
  } else {
    log.info(`Executing node heartbeat via gateway: ${gatewayUrl}/nodes/heartbeat`);
  }

  // Resolve active file-sync folders for heartbeat capability reporting
  const resolveFileSyncFolders = async () => {
    if (dbDisabled) return [];
    try {
      const folders = await fileSyncStore.listFolders(nodeId);
      return folders
        .filter(f => f.status === 'active')
        .map(f => ({ name: f.name, localPath: f.localPath, mode: 'incremental' as const }));
    } catch {
      return [];
    }
  };

  /**
   * 网关说"该换钥匙了"就自助轮换一次。失败不抛：旧凭据还有重叠窗口，
   * 下一轮心跳会再试（心跳是最便宜的重试时钟）。
   */
  const maybeRotateNodeCredential = (response: HeartbeatResponse): void => {
    if (!gatewayUrl || !nodeCredential || !response.credentialRotationDue || rotationInFlight) return;
    rotationInFlight = true;
    const current = nodeCredential;
    void rotateNodeCredentialViaGateway({ gatewayUrl, nodeId, credential: current })
      .then((rotated) => {
        if (!rotated) {
          log.warn('node credential rotation failed; keeping current credential (overlap window still open)');
          return;
        }
        nodeCredential = rotated.credential;
        if (rotated.persisted) {
          log.info(`node credential rotated (expires ${rotated.expiresAt ?? 'unknown'})`);
        } else {
          pendingCredentialPersist = { credential: rotated.credential, ...(rotated.expiresAt ? { expiresAt: rotated.expiresAt } : {}) };
          log.warn('node credential rotated in memory but could not be persisted; will retry on next heartbeat');
        }
      })
      .catch((err: unknown) => {
        log.warn(`node credential rotation error: ${err instanceof Error ? err.message : String(err)}`);
      })
      .finally(() => {
        rotationInFlight = false;
      });
  };

  const reportHeartbeat = createHeartbeatReporter(async () => {
    if (pendingCredentialPersist) {
      try {
        saveNodeCredential(nodeId, pendingCredentialPersist.credential, pendingCredentialPersist.expiresAt);
        pendingCredentialPersist = undefined;
        log.info('node credential persisted after earlier write failure');
      } catch {
        // 继续用内存里的新值；下一轮再试。
      }
    }
    const folders = await resolveFileSyncFolders();
    const response = await heartbeatNode(nodeId, publicUrl, version, nodeKind, connectModes, lifecycle, gatewayUrl, folders, agentKey, nodeCredential, versionSource);
    maybeRotateNodeCredential(response);
  }, log, { baseIntervalMs: 10_000, backoffFactor: 3, maxBackoffMs: 900_000 });

  // Self-scheduling heartbeat: fires immediately, then waits
  // reportHeartbeat.nextIntervalMs() (base on success, exponential backoff
  // while the gateway is unreachable). Never blocks server startup.
  let heartbeatTimer: ReturnType<typeof setTimeout> | undefined;
  const scheduleHeartbeat = async () => {
    await reportHeartbeat.run();
    heartbeatTimer = setTimeout(() => {
      void scheduleHeartbeat();
    }, reportHeartbeat.nextIntervalMs());
  };
  void scheduleHeartbeat();

  const server = createServer(async (req, res) => {
    try {
      const route = new URL(req.url ?? '/', publicUrl);
      if (req.method === 'GET' && route.pathname === '/health') {
        sendJson(res, 200, {
          status: 'ok',
          nodeId,
          publicUrl,
          version,
          versionSource,
          nodeKind,
          connectModes,
          lifecycle: lifecycle.status,
          acceptingTasks: lifecycle.acceptingTasks,
          activeTaskCount: lifecycle.activeTaskCount,
          taskTokenMode,
          db: dbDisabled ? 'none' : 'postgres',
          eventBacklog: activeEventBacklog,
          leaseTransport: gatewayUrl ? 'http-when-token' : 'db',
        });
        return;
      }

      if (route.pathname.startsWith('/v1/artifacts')) {
        if (!isAuthorized(req, agentKey)) { sendJson(res, 401, { error: 'unauthorized' }); return; }
        if (dbDisabled) {
          await handleStatelessArtifactRoute(req, res, route, nodeId, artifactStorageRoot, readJson, sendJson);
          return;
        }
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
            await streamAssignedAgentTask(res, body, nodeId, activeTask.controller, gatewayUrl, taskTokenMode, dbDisabled ? 'callback' : 'db');
            return;
          }
          const result = await runAssignedAgentTask(body, nodeId, undefined, activeTask.controller, gatewayUrl, taskTokenMode, dbDisabled ? 'callback' : 'db');
          sendJson(res, 200, result);
          return;
        } finally {
          activeTask.finish();
        }
      }

      if (route.pathname.startsWith('/v1/file-sync')) {
        if (!isAuthorized(req, agentKey)) { sendJson(res, 401, { error: 'unauthorized' }); return; }
        if (dbDisabled) { sendJson(res, 503, { error: 'file_sync_unavailable_in_stateless_mode' }); return; }
        await handleFileSyncRoute(req, res, route, nodeId, readJson, normalizeOptionalString, normalizePositiveInteger, sendJson);
        return;
      }

      sendJson(res, 404, { error: 'not found' });
    } catch (err: any) {
      log.error(err?.stack ?? String(err));
      sendJson(res, 500, { error: err?.message ?? String(err) });
    }
  });

  await new Promise<void>((resolve) => server.listen(port, host, resolve));
  log.info(`Executor node ${nodeId} listening on ${publicUrl}`);

  // Start periodic file-sync scanning for folders registered on this node
  const stopPeriodicSync = dbDisabled ? (() => {}) : startPeriodicSync(nodeId);
  let shutdownPromise: Promise<void> | undefined;
  const shutdown = () => shutdownPromise ??= shutdownExecutor({
    server,
    lifecycle,
    shutdownGraceMs,
    stopHeartbeat: () => clearTimeout(heartbeatTimer),
    stopPeriodicSync,
    writeHeartbeat: async () => {
      await heartbeatNode(
        nodeId,
        publicUrl,
        version,
        nodeKind,
        connectModes,
        lifecycle,
        gatewayUrl,
        await resolveFileSyncFolders(),
        agentKey,
        nodeCredential,
        versionSource,
      );
    },
  });

  return { server, lifecycle, shutdown };
}

async function streamAssignedAgentTask(
  res: ServerResponse,
  body: RunAgentRequest,
  nodeId: string,
  controller: AbortController,
  gatewayUrl?: string,
  taskTokenMode: 'auto' | 'required' | 'off' = 'auto',
  eventPersistence: 'db' | 'callback' = 'db',
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
    await runAssignedAgentTask(body, nodeId, emit, controller, gatewayUrl, taskTokenMode, eventPersistence);
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
  gatewayUrl?: string,
  taskTokenMode: 'auto' | 'required' | 'off' = 'auto',
  eventPersistence: 'db' | 'callback' = 'db',
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
  const kernelEvents: unknown[] = [];

  if (taskTokenMode === 'required' && !body.taskToken) {
    throw new Error('task token is required but the dispatch did not carry one');
  }
  if (taskTokenMode === 'required' && !gatewayUrl) {
    throw new Error('task token mode is required but GATEWAY_URL is not configured');
  }
  if (taskTokenMode === 'auto' && body.taskToken && !gatewayUrl) {
    // Transitional local executors (launchd) still point at the DB and may not
    // have GATEWAY_URL. Do not break them merely because the gateway minted a
    // token. Remote nodes must set EXECUTOR_TASK_TOKEN_MODE=required to turn
    // this into a hard failure.
    log.warn('task token received without GATEWAY_URL; using direct DB lease (auto mode)');
  }
  const leaseHttp: TaskLeaseHttpTransport | undefined =
    taskTokenMode !== 'off' && body.taskToken && gatewayUrl
      ? { gatewayUrl, taskToken: body.taskToken }
      : undefined;

  const eventSink = eventPersistence === 'callback' && gatewayUrl
    ? new GatewayEventSink({ gatewayUrl, taskRunId, getToken: () => leaseHttp?.taskToken, spoolRoot: executorEventSpoolRoot })
    : undefined;

  const heartbeat = setInterval(() => {
    _renewTaskLease(taskRunId, nodeId, leaseVersion, body.agentTaskLease, leaseMs, controller, leaseHttp).catch((err) => {
      log.warn(`task lease heartbeat failed: ${err.message ?? String(err)}`);
    });
  }, Math.max(1_000, Math.floor(leaseMs / 3)));

  try {
    const initialTaskRunLease = await _renewTaskRunLease(taskRunId, nodeId, leaseVersion, leaseMs, leaseHttp);
    if (initialTaskRunLease.ok && initialTaskRunLease.taskToken && leaseHttp) {
      leaseHttp.taskToken = initialTaskRunLease.taskToken;
    }
    const initialAgentTaskLease = body.agentTaskLease
      ? await _renewAgentTaskLease(taskRunId, nodeId, body.agentTaskLease, leaseMs, leaseHttp)
      : { ok: true as const };
    if (!initialTaskRunLease.ok || !initialAgentTaskLease.ok) {
      const reason = initialTaskRunLease.ok ? 'agent_task_lease_lost' : initialTaskRunLease.reason;
      throw new Error(`execution lease lost before executor start for task run ${taskRunId} (${reason})`);
    }
    const executionKernel = resolveExecutionKernel(body.executionKernelKind);
    const result = await executionKernel.run(prompt, {
      ...(body.config ?? {}),
      identity: body.config?.identity ?? {
        name: 'default',
        level: resolveIdentityLevelForExecutionPath('remote-executor'),
      },
      signal: controller.signal,
      eventPersistence,
      onSessionEvent: async (event) => {
        events.push(event);
        await eventSink?.enqueue(event);
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
    }, (kernelEvent) => {
      kernelEvents.push(kernelEvent);
      emit?.({ type: 'kernel_event', kernelEvent });
    });
    emit?.({ type: 'result', result });
    const eventBacklog = eventSink ? await eventSink.drain(10_000) : 0;
    activeEventBacklog = eventBacklog;
    if (eventBacklog > 0) log.warn(`event sink backlog after task ${taskRunId}: ${eventBacklog}`);
    return { result, events, deltas, toolCallStates, kernelEvents, eventBacklog };
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
let activeEventBacklog = 0;
let executorEventSpoolRoot: string | undefined;
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
