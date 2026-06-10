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
import { printOnboardingReport } from '@los/infra/discovery';
import { getLogger } from '@los/infra/logger';
import { registerLogRoutes } from './routes/log-routes.js';
import { registerArtifactRoutes } from './routes/artifact-routes.js';
import { registerNodeCommandRoutes } from './routes/node-command-routes.js';
import { registerNodeRoutes } from './routes/node-routes.js';
import { registerServiceRoutes } from './routes/service-routes.js';
import { registerMCPRoutes } from './routes/mcp-routes.js';
import { registerSkillRoutes } from './routes/skill-routes.js';
import { registerRuleRoutes } from './routes/rule-routes.js';
import { registerTodoRoutes } from './routes/todo-routes.js';
import { registerAgentTaskGraphRoutes } from './routes/agent-task-graph-routes.js';
import { ensureIdempotencyStore } from './idempotency.js';
import { registerChatRoute } from './chat-route.js';
import { getRequestContext, registerRequestContext } from './request-context.js';
import authMiddleware from './auth-middleware.js';
import { reclaimOrphanedRuns } from './chat-session-helpers.js';
import { registerProviderRoutes } from './routes/provider-routes.js';
import { registerMemoryRoutes } from './routes/memory-routes.js';
import { registerSessionRoutes } from './routes/session-routes.js';
import { registerSseRoutes, setupLiveEventPush, registerLiveEventRoutes } from './routes/sse-routes.js';
import { registerTaskRoutes } from './routes/task-routes.js';
import { registerRunRoutes } from './routes/run-routes.js';
import { registerProjectRoutes } from './routes/project-routes.js';
import { ensureTaskRunStore, recoverExpiredTaskRunsWithAdvisoryLock } from '@los/agent/task-runs';
import { ensureExecutorNodeStore } from '@los/agent/executor-nodes';
import { ensureRunSpecStore } from '@los/agent/run-specs';
import { ensureServiceInstanceStore, loadServiceInstance, upsertServiceInstanceHeartbeat } from '@los/agent/service-instances';
import { ensureTodoStore, seedLosPlanningTodos } from '@los/agent/todos';
import { appendSessionEvent } from '@los/agent/session-events';

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

  await app.register(cors, { origin: config.server.corsOrigin });
  registerRequestContext(app, config);
  await authMiddleware(app, { config });

  // ── Static HTML ──────────────────────────────────────

  const webIndexExists = existsSync(WEB_INDEX_PATH);
  await app.register(fastifyStatic, {
    root: webIndexExists ? WEB_DIST_ROOT : __dirname,
    prefix: '/',
  });

  app.get('/', async (_req, reply) => {
    const indexPath = webIndexExists ? WEB_INDEX_PATH : LEGACY_INDEX_PATH;
    return reply.type('text/html').send(readFileSync(indexPath, 'utf-8'));
  });

  // ── Providers & Onboarding ────────────────────────
  registerProviderRoutes(app);

  // ── Workspace ────────────────────────────────────────
  app.get('/workspace', async () => ({
    workspaceRoot: DEFAULT_WORKSPACE_ROOT,
    cwd: process.cwd(),
  }));

  // ── Projects ────────────────────────────────────────
  registerProjectRoutes(app);

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

  app.get('/settings', async () => ({
    server: { port: config.server.port, host: config.server.host },
    defaultProjectId: config.defaultProjectId,
    agent: {
      defaultProvider: config.agent.defaultProvider,
      defaultModel: config.agent.defaultModel,
      maxLoops: config.agent.maxLoops,
      sandboxMode: config.agent.sandboxMode,
    },
    memory: { ftsEnabled: config.memory.ftsEnabled, maxObservations: config.memory.maxObservations },
    executor: {
      enabled: config.executor.enabled,
      nodeId: config.executor.nodeId,
      nodeUrl: config.executor.nodeUrl,
      meshNodeCount: config.executor.meshNodes.length,
    },
    providers: Object.entries(config.providers).map(([name, p]) => ({
      name, enabled: p.enabled ?? false,
      hasApiKey: typeof p.apiKey === 'string' && p.apiKey.length > 0,
      model: p.model ?? null, weight: p.weight ?? null,
    })),
  }));

  // ── Logs & extracted routes ─────────────────────────
  registerLogRoutes(app, { runtimeLogDir: RUNTIME_LOG_DIR, runtimeLogPath: RUNTIME_LOG_PATH });
  registerArtifactRoutes(app, { storageRoot: ARTIFACT_STORAGE_ROOT, executorAgentKey: config.executor.agentKey });
  registerNodeCommandRoutes(app, { executorAgentKey: config.executor.agentKey });
  registerTodoRoutes(app);
  registerAgentTaskGraphRoutes(app);
  registerNodeRoutes(app);
  registerServiceRoutes(app, { serviceId: service.serviceId, serviceKind: 'gateway' });
  registerMCPRoutes(app);
  registerSkillRoutes(app, DEFAULT_WORKSPACE_ROOT);
  registerRuleRoutes(app, DEFAULT_WORKSPACE_ROOT);
  registerChatRoute(app, config, DEFAULT_WORKSPACE_ROOT, service.serviceId);

  // ── Feature routes ─────────────────────────────────
  registerMemoryRoutes(app);
  registerSessionRoutes(app);
  registerSseRoutes(app);
  registerTaskRoutes(app);
  registerRunRoutes(app);
  setupLiveEventPush(app);
  registerLiveEventRoutes(app);

  // ── SPA fallback ─────────────────────────────────────
  app.setNotFoundHandler((req, reply) => {
    if (req.method !== 'GET') return reply.status(404).send({ error: 'Not found' });
    const indexPath = webIndexExists ? WEB_INDEX_PATH : LEGACY_INDEX_PATH;
    return reply.type('text/html').send(readFileSync(indexPath, 'utf-8'));
  });

  return app;
}

// ── CLI entry ──────────────────────────────────────────

export async function startServer(port?: number, host?: string) {
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
  await ensureRunSpecStore();
  const recovery = await recoverExpiredTaskRunsWithAdvisoryLock('gateway_startup_recovery');
  if (!recovery.lockAcquired) {
    log.info('Gateway startup recovery skipped because another service owns the advisory lock');
  }
  for (const task of recovery.recovered) {
    await appendSessionEvent({
      sessionId: task.sessionId, tenantId: task.tenantId, projectId: task.projectId,
      userId: task.userId, nodeId: task.nodeId, requestId: task.requestId, traceId: task.traceId,
      type: 'task.failed',
      payload: { taskRunId: task.id, traceId: task.traceId, nodeId: task.nodeId ?? null, reason: 'gateway_startup_recovery' },
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

  const ORPHAN_REAPER_MS = 30_000;
  const orphanReaper = setInterval(() => {
    reclaimOrphanedRuns(service.serviceId).then((result) => {
      if (result.claimedRunSpecIds.length > 0) {
        log.info(`Orphan reaper claimed ${result.claimedRunSpecIds.length} run(s) from stale gateways: ${result.staleGatewayIds.join(', ')}`);
      }
      if (result.errors.length > 0) log.warn(`Orphan reaper errors: ${result.errors.join('; ')}`);
    }).catch((err) => log.warn(`Orphan reaper failed: ${err.message ?? String(err)}`));
  }, ORPHAN_REAPER_MS);
  app.addHook('onClose', async () => clearInterval(orphanReaper));

  await app.listen({ port: p, host: h });
  log.info(`Gateway ${service.serviceId} listening on http://${h}:${p}`);
  return app;
}

if (process.argv[1]?.endsWith('server.ts') || process.argv[1]?.endsWith('server.js')) {
  void startServer().catch((error) => {
    log.error('Gateway failed to start', { error: error instanceof Error ? error.message : String(error) });
    process.exitCode = 1;
  });
}

export function resolveGatewayServiceIdentity(
  config: ReturnType<typeof getConfig>,
  port = config.server.port,
  host = config.server.host,
): GatewayServiceIdentity {
  const hostLabel = hostname();
  const bindUrl = `http://${host}:${port}`;
  const publicUrl = process.env.GATEWAY_PUBLIC_URL ?? process.env.LOS_SERVICE_URL ?? bindUrl;
  const sid = (process.env.GATEWAY_SERVICE_ID ?? process.env.LOS_SERVICE_ID ?? `gateway-${hostLabel}-${port}`)
    .toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'local';
  return { serviceId: sid, bindUrl, publicUrl, hostLabel };
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
    capabilities: { chat_api: true, web_ui: true, artifact_proxy: true, node_registry: true, service_registry: true },
    health: { db_ok: true, schema_ok: true },
    load: { active_requests: 0, active_streams: 0 },
    priority: 100,
  });
}

export function selectAgentModelProviders(config: ReturnType<typeof getConfig>): string[] {
  const core = new Set(['deepseek', 'deepseek-anthropic', 'minimax', 'openai', 'codex', 'packycode']);
  const configured = Object.entries(config.providers)
    .filter(([name, provider]) => core.has(name) && provider.enabled)
    .map(([name]) => name);
  if (configured.length > 0) return configured;
  return [config.agent.defaultProvider];
}
