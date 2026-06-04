/**
 * @los/gateway — Fastify HTTP server with SSE streaming.
 *
 * Inspired by Hermes Web UI (BFF pattern) and Open WebUI.
 * Routes: POST /chat (SSE stream), GET/POST /memory, GET /health.
 */

import Fastify from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import { existsSync, readFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getConfig, loadConfig, printConfigDiagnostics } from '@los/infra/config';
import { initDb } from '@los/infra/db';
import { describeProviderReadiness, printOnboardingReport, discoverAll, type DiscoveredProvider } from '@los/infra/discovery';
import { getLogger } from '@los/infra/logger';
import { createProvider } from '@los/agent';
import { registerLogRoutes } from './log-routes.js';
import { registerArtifactRoutes } from './artifact-routes.js';
import { registerNodeCommandRoutes } from './node-command-routes.js';
import { registerNodeRoutes } from './node-routes.js';
import { registerServiceRoutes } from './service-routes.js';
import { registerMCPRoutes } from './mcp-routes.js';
import { registerTodoRoutes } from './todo-routes.js';
import { ensureIdempotencyStore } from './idempotency.js';
import { registerChatRoute } from './chat-route.js';
import { getRequestContext, registerRequestContext } from './request-context.js';
import { cancelScheduledTask } from '@los/agent/scheduler';
import { ensureSessionStore, loadSession, listSessions } from '@los/agent/session';
import {
  ensureTaskRunStore,
  loadTaskRun,
  listTaskRuns,
  recoverExpiredTaskRunsWithAdvisoryLock,
  updateTaskRun,
} from '@los/agent/task-runs';
import { ensureExecutorNodeStore } from '@los/agent/executor-nodes';
import {
  ensureServiceInstanceStore,
  loadServiceInstance,
  upsertServiceInstanceHeartbeat,
} from '@los/agent/service-instances';
import {
  ensureTodoStore,
  seedLosPlanningTodos,
} from '@los/agent/todos';
import {
  ensureSessionEventStore,
  appendSessionEvent,
  listSessionEvents,
  getSessionObservability,
} from '@los/agent/session-events';
import {
  ensureMemoryStore, addObservation, searchObservations,
  getStats, syncMemoryMd, deleteObservation
} from '@los/memory';

const log = getLogger('gateway');
const VERSION = '0.1.0';
const SERVICE_HEARTBEAT_MS = 10_000;
const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_WORKSPACE_ROOT = resolve(__dirname, '../../..');
const WORKSPACE_ROOT = resolve(__dirname, '../../..');
const WEB_DIST_ROOT = resolve(__dirname, '../../web/dist');
const WEB_INDEX_PATH = join(WEB_DIST_ROOT, 'index.html');
const LEGACY_INDEX_PATH = resolve(__dirname, '../src/index.html');
const RUNTIME_LOG_DIR = join(WORKSPACE_ROOT, '.los-runtime');
const RUNTIME_LOG_PATH = join(RUNTIME_LOG_DIR, 'gateway.log');
const ARTIFACT_STORAGE_ROOT = join(WORKSPACE_ROOT, '.los-runtime', 'artifacts');

export type GatewayServiceIdentity = {
  serviceId: string;
  bindUrl: string;
  publicUrl: string;
  hostLabel: string;
};

export async function createServer(service: GatewayServiceIdentity = resolveGatewayServiceIdentity(getConfig())) {
  const config = getConfig();
  const app = Fastify({ logger: false });

  await app.register(cors, { origin: true });
  registerRequestContext(app);

  // ── Static HTML ──────────────────────────────────────

  const webIndexExists = existsSync(WEB_INDEX_PATH);
  await app.register(fastifyStatic, {
    root: webIndexExists ? WEB_DIST_ROOT : __dirname,
    prefix: '/',
  });

  // Index page
  app.get('/', async (_req, reply) => {
    const indexPath = webIndexExists ? WEB_INDEX_PATH : LEGACY_INDEX_PATH;
    return reply.type('text/html').send(readFileSync(indexPath, 'utf-8'));
  });

  // ── Onboarding ──────────────────────────────────────

  app.get('/onboarding', async () => {
    const report = await discoverAll();
    return {
      ...report,
      providers: report.providers.map(sanitizeProviderDiscovery),
    };
  });

  app.get('/providers/models', async (req) => {
    const query = req.query as { provider?: string };
    const requestedProvider = normalizeOptionalString(query.provider);
    const providerNames = requestedProvider
      ? [requestedProvider]
      : selectAgentModelProviders(config);

    const providers = await Promise.all(providerNames.map(async (providerName) => {
      const providerConfig = config.providers[providerName];
      try {
        const provider = createProvider(providerName);
        if (!provider.listModels) {
          return {
            provider: providerName,
            ok: false,
            enabled: providerConfig?.enabled ?? false,
            hasApiKey: Boolean(providerConfig?.apiKey),
            source: readProviderSource(providerConfig),
            model: provider.profile.model,
            baseUrl: provider.profile.baseUrl,
            profile: provider.profile,
            models: [],
            error: 'provider does not expose a model list API',
          };
        }

        const models = await provider.listModels();
        return {
          provider: providerName,
          ok: true,
          enabled: providerConfig?.enabled ?? true,
          hasApiKey: Boolean(providerConfig?.apiKey),
          source: readProviderSource(providerConfig),
          model: provider.profile.model,
          baseUrl: provider.profile.baseUrl,
          profile: provider.profile,
          count: models.length,
          models,
        };
      } catch (err: any) {
        return {
          provider: providerName,
          ok: false,
          enabled: providerConfig?.enabled ?? false,
          hasApiKey: Boolean(providerConfig?.apiKey),
          source: readProviderSource(providerConfig),
          count: 0,
          models: [],
          error: sanitizeErrorMessage(err?.message ?? String(err)),
        };
      }
    }));

    return {
      provider: requestedProvider ?? null,
      count: providers.length,
      providers,
    };
  });

  // ── Health ───────────────────────────────────────────

  app.get('/health', async () => {
    const current = await loadServiceInstance(service.serviceId).catch(() => null);
    return {
      status: 'ok',
      uptime: process.uptime(),
      serviceId: service.serviceId,
      serviceKind: 'gateway',
      ready: current?.readiness.ready ?? false,
      blockers: current?.readiness.blockers ?? ['service:not_registered'],
    };
  });

  // ── Logs ─────────────────────────────────────────────

  registerLogRoutes(app, {
    runtimeLogDir: RUNTIME_LOG_DIR,
    runtimeLogPath: RUNTIME_LOG_PATH,
  });
  registerArtifactRoutes(app, {
    storageRoot: ARTIFACT_STORAGE_ROOT,
    executorAgentKey: config.executor.agentKey,
  });
  registerNodeCommandRoutes(app, {
    executorAgentKey: config.executor.agentKey,
  });
  registerTodoRoutes(app);
  registerNodeRoutes(app);
  registerServiceRoutes(app, {
    serviceId: service.serviceId,
    serviceKind: 'gateway',
  });
  registerMCPRoutes(app);

  registerChatRoute(app, config, DEFAULT_WORKSPACE_ROOT);

  // ── Memory ────────────────────────────────────────────

  app.get('/memory', async (req) => {
    const { q, kind, limit } = req.query as { q?: string; kind?: string; limit?: string };
    await ensureMemoryStore();
    const results = await searchObservations(q ?? '', {
      kind,
      limit: limit ? parseInt(limit) : 20,
    });
    return { count: results.length, results };
  });

  app.post('/memory', async (req) => {
    const { title, summary, kind, tags, content, source } = req.body as any;
    const context = getRequestContext(req);
    await ensureMemoryStore();
    const obs = await addObservation({
      title,
      summary,
      kind,
      tags,
      content,
      source,
      tenantId: context.tenantId,
      projectId: context.projectId,
      userId: context.userId,
      requestId: context.requestId,
      traceId: context.traceId,
    });
    return obs;
  });

  app.delete('/memory/:id', async (req) => {
    const { id } = req.params as { id: string };
    await ensureMemoryStore();
    const ok = await deleteObservation(parseInt(id));
    return { ok };
  });

  app.get('/memory/stats', async () => {
    await ensureMemoryStore();
    return await getStats();
  });

  // ── Sessions ──────────────────────────────────────────

  app.get('/sessions', async () => {
    await ensureSessionStore();
    return await listSessions();
  });

  app.get('/sessions/:id', async (req) => {
    const { id } = req.params as { id: string };
    await ensureSessionStore();
    const session = await loadSession(id);
    if (!session) return { error: 'Not found' };
    return session;
  });

  app.get('/sessions/:id/events', async (req) => {
    const { id } = req.params as { id: string };
    const rawLimit = Number((req.query as { limit?: string }).limit ?? 200);
    const limit = Number.isFinite(rawLimit) && rawLimit > 0 && rawLimit <= 10000 ? rawLimit : 200;
    await ensureSessionEventStore();
    const events = await listSessionEvents(id, limit);
    return {
      sessionId: id,
      count: events.length,
      events,
    };
  });

  app.get('/sessions/:id/observability', async (req) => {
    const { id } = req.params as { id: string };
    await ensureSessionEventStore();
    return await getSessionObservability(id);
  });

  // ── Tasks ─────────────────────────────────────────────

  app.get('/tasks', async () => {
    await ensureTaskRunStore();
    return await listTaskRuns();
  });

  app.get('/tasks/:id', async (req) => {
    const { id } = req.params as { id: string };
    await ensureTaskRunStore();
    const taskRun = await loadTaskRun(id);
    if (!taskRun) return { error: 'Not found' };
    return taskRun;
  });

  app.post('/tasks/:id/cancel', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = req.body as { reason?: string } | undefined;
    const reason = normalizeOptionalString(body?.reason) ?? 'cancelled_by_request';

    await ensureTaskRunStore();
    const taskRun = await loadTaskRun(id);
    if (!taskRun) {
      return reply.status(404).send({ error: 'Not found' });
    }

    const live = cancelScheduledTask(id, reason);
    if (live) {
      await updateTaskRun(id, {
        status: 'cancelled',
        metadata: {
          ...taskRun.metadata,
          cancelReason: reason,
        },
      }).catch(() => undefined);
      return { ok: true, live: true, taskRunId: id, status: 'cancelled', reason };
    }

    if (taskRun.status === 'queued' || taskRun.status === 'running') {
      const cancelled = await updateTaskRun(id, {
        status: 'cancelled',
        metadata: {
          ...taskRun.metadata,
          cancelReason: reason,
        },
      });
      const finalTask = cancelled ?? taskRun;
      await appendSessionEvent({
        sessionId: finalTask.sessionId,
        tenantId: finalTask.tenantId,
        projectId: finalTask.projectId,
        userId: finalTask.userId,
        nodeId: finalTask.nodeId,
        requestId: finalTask.requestId,
        traceId: finalTask.traceId,
        type: 'task.cancelled',
        payload: {
          taskRunId: finalTask.id,
          traceId: finalTask.traceId,
          dedupeKey: finalTask.dedupeKey ?? null,
          reason,
          live: false,
        },
      }).catch(() => undefined);
      return {
        ok: true,
        live: false,
        taskRun: finalTask,
      };
    }

    return {
      ok: false,
      live: false,
      taskRun,
      reason: `Task is already ${taskRun.status}`,
    };
  });

  // ── Sync MEMORY.md ────────────────────────────────────

  app.post('/memory/sync-md', async (req) => {
    const { workspaceRoot } = req.body as { workspaceRoot: string };
    await ensureMemoryStore();
    const observations = await searchObservations('', { limit: 50 });
    syncMemoryMd(workspaceRoot, observations);
    return { ok: true, count: observations.length };
  });

  return app;
}

// ── CLI entry ──────────────────────────────────────────

export async function startServer(port?: number, host?: string) {
  // Bootstrap: load config → init DB → start server
  const config = await loadConfig();
  const p = port ?? config.server.port;
  const h = host ?? config.server.host;
  const service = resolveGatewayServiceIdentity(config, p, h);

  await initDb(config.databaseUrl);
  await ensureTodoStore();
  await ensureIdempotencyStore();
  await ensureExecutorNodeStore();
  await ensureServiceInstanceStore();
  await heartbeatGatewayService(service);
  await ensureTaskRunStore();
  const recovery = await recoverExpiredTaskRunsWithAdvisoryLock('gateway_startup_recovery');
  if (!recovery.lockAcquired) {
    log.info('Gateway startup recovery skipped because another service owns the advisory lock');
  }
  for (const task of recovery.recovered) {
    await appendSessionEvent({
      sessionId: task.sessionId,
      tenantId: task.tenantId,
      projectId: task.projectId,
      userId: task.userId,
      nodeId: task.nodeId,
      requestId: task.requestId,
      traceId: task.traceId,
      type: 'task.failed',
      payload: {
        taskRunId: task.id,
        traceId: task.traceId,
        nodeId: task.nodeId ?? null,
        reason: 'gateway_startup_recovery',
      },
    }).catch(() => undefined);
  }
  await seedLosPlanningTodos();
  console.log(await printOnboardingReport());
  console.log(printConfigDiagnostics(config));

  const app = await createServer(service);
  const heartbeat = setInterval(() => {
    heartbeatGatewayService(service).catch((err) => log.warn(`service heartbeat failed: ${err.message ?? String(err)}`));
  }, SERVICE_HEARTBEAT_MS);
  app.addHook('onClose', async () => clearInterval(heartbeat));

  await app.listen({ port: p, host: h });
  log.info(`Gateway ${service.serviceId} listening on http://${h}:${p}`);

  return app;
}

// Allow direct execution
if (process.argv[1]?.endsWith('server.ts') || process.argv[1]?.endsWith('server.js')) {
  void startServer()
    .catch((error) => {
      log.error('Gateway failed to start', {
        error: error instanceof Error ? error.message : String(error),
      });
      process.exitCode = 1;
    });
}

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function sanitizeProviderDiscovery(provider: DiscoveredProvider): Record<string, unknown> {
  const { apiKey, ...rest } = provider;
  return {
    ...rest,
    hasApiKey: typeof apiKey === 'string' && apiKey.length > 0,
    readiness: describeProviderReadiness(provider),
  };
}

function sanitizeErrorMessage(message: string): string {
  return message.replace(/sk-[A-Za-z0-9_-]{8,}/g, 'sk-REDACTED');
}

function readProviderSource(provider: unknown): string | null {
  if (!provider || typeof provider !== 'object') return null;
  const source = (provider as Record<string, unknown>)._source;
  return typeof source === 'string' && source.trim() ? source : null;
}

export function resolveGatewayServiceIdentity(
  config: ReturnType<typeof getConfig>,
  port = config.server.port,
  host = config.server.host,
): GatewayServiceIdentity {
  const hostLabel = hostname();
  const bindUrl = `http://${host}:${port}`;
  const publicUrl = process.env.GATEWAY_PUBLIC_URL ?? process.env.LOS_SERVICE_URL ?? bindUrl;
  const serviceId = process.env.GATEWAY_SERVICE_ID
    ?? process.env.LOS_SERVICE_ID
    ?? `gateway-${sanitizeServiceId(hostLabel)}-${port}`;
  return {
    serviceId,
    bindUrl,
    publicUrl,
    hostLabel,
  };
}

async function heartbeatGatewayService(service: GatewayServiceIdentity): Promise<void> {
  await upsertServiceInstanceHeartbeat({
    serviceId: service.serviceId,
    serviceKind: 'gateway',
    hostLabel: service.hostLabel,
    bindUrl: service.bindUrl,
    publicUrl: service.publicUrl,
    version: VERSION,
    role: 'active',
    capabilities: {
      chat_api: true,
      web_ui: true,
      artifact_proxy: true,
      node_registry: true,
      service_registry: true,
    },
    health: {
      db_ok: true,
      schema_ok: true,
    },
    load: {
      active_requests: 0,
      active_streams: 0,
    },
    priority: 100,
  });
}

function sanitizeServiceId(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'local';
}

function selectAgentModelProviders(config: ReturnType<typeof getConfig>): string[] {
  const core = new Set(['deepseek', 'openai', 'codex', 'packycode']);
  const configured = Object.entries(config.providers)
    .filter(([name, provider]) => core.has(name) && provider.enabled)
    .map(([name]) => name);
  if (configured.length > 0) return configured;
  return [config.agent.defaultProvider];
}
