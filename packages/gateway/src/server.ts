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
import { getConfig, setConfig, loadConfig, printConfigDiagnostics } from '@los/infra/config';
import { initDb, getDb } from '@los/infra/db';
import { getLogger } from '@los/infra/logger';
import { migrateDir } from '@los/infra/migrate';
import { getMigrateDir } from '@los/infra/config';
import { printOnboardingReport } from '@los/infra/discovery';
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
import { registerDiagnosticsRoutes } from './routes/diagnostics-routes.js';
import { ensureIdempotencyStore } from './idempotency.js';
import { registerChatRoute } from './chat-route.js';
import { getRequestContext, registerRequestContext } from './request-context.js';
import authMiddleware from './auth-middleware.js';
import { reclaimOrphanedRuns } from './chat-session-helpers.js';
import { registerProviderRoutes } from './routes/provider-routes.js';
import { registerMemoryRoutes } from './routes/memory-routes.js';
import { registerSessionRoutes } from './routes/session-routes.js';
import { registerTraceRoutes } from './routes/trace-routes.js';
import { registerSseRoutes, setupLiveEventPush, registerLiveEventRoutes } from './routes/sse-routes.js';
import { registerTaskRoutes } from './routes/task-routes.js';
import { registerRunRoutes } from './routes/run-routes.js';
import { registerProjectRoutes } from './routes/project-routes.js';
import { registerFileSyncRoutes } from './routes/file-sync-routes.js';
import { registerIntegrationRoutes } from './routes/integration-routes.js';
import { ensureTaskRunStore, recoverExpiredTaskRunsWithAdvisoryLock } from '@los/agent/task-runs';
import { ensureAgentTaskGraphStore, recoverExpiredAgentTasksWithAdvisoryLock } from '@los/agent/agent-task-graph';
import { ensureExecutorNodeStore } from '@los/agent/executor-nodes';
import { ensureRunSpecStore } from '@los/agent/run-specs';
import { ensureServiceInstanceStore, loadServiceInstance, upsertServiceInstanceHeartbeat } from '@los/agent/service-instances';
import { ensureTodoStore, seedLosPlanningTodos } from '@los/agent/todos';
import { appendSessionEvent } from '@los/agent/session-events';
import { transitionExecutionState } from '@los/agent/execution-store';
import { ensureMemoryStore, ensureMemoryCompactionStore, ensureProceduralCandidateStore } from '@los/memory';

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
  registerFileSyncRoutes(app, { executorAgentKey: config.executor.agentKey });

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
    server: { port: config.server.port, host: config.server.host, corsOrigin: config.server.corsOrigin },
    defaultProjectId: config.defaultProjectId,
    auth: { enabled: config.auth.enabled },
    agent: {
      defaultProvider: config.agent.defaultProvider,
      defaultModel: config.agent.defaultModel,
      maxLoops: config.agent.maxLoops,
      sandboxMode: config.agent.sandboxMode,
      systemPrompt: config.agent.systemPrompt ?? null,
      identity: {
        name: config.agent.identity.name,
        level: config.agent.identity.level ?? null,
        inheritForChildren: config.agent.identity.inheritForChildren,
      },
    },
    judge: {
      provider: config.judge.provider ?? null,
      model: config.judge.model ?? null,
      systemPrompt: config.judge.systemPrompt ?? null,
    },
    review: {
      enabled: config.review.enabled,
      roles: Object.fromEntries(
        Object.entries(config.review.roles).map(([name, r]) => [name, {
          provider: r.provider ?? null,
          model: r.model ?? null,
          systemPrompt: r.systemPrompt ?? null,
          blockingSeverity: r.blockingSeverity,
          enabled: r.enabled,
        }])
      ),
    },
    memory: {
      ftsEnabled: config.memory.ftsEnabled,
      maxObservations: config.memory.maxObservations,
      selfReflectionEnabled: config.memory.selfReflectionEnabled,
    },
    executor: {
      enabled: config.executor.enabled,
      nodeId: config.executor.nodeId,
      nodeUrl: config.executor.nodeUrl,
      connectModes: config.executor.connectModes,
      meshNodes: config.executor.meshNodes,
      meshNodeCount: config.executor.meshNodes.length,
    },
    providers: Object.entries(config.providers).map(([name, p]) => ({
      name, enabled: p.enabled ?? false,
      hasApiKey: typeof p.apiKey === 'string' && p.apiKey.length > 0,
      model: p.model ?? null, weight: p.weight ?? null,
    })),
  }));

  app.patch('/settings', async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return reply.status(400).send({ error: 'Request body must be a JSON object' });
    }
    const current = getConfig();
    // Deep-merge the patch into current config. Only allow top-level keys
    // that exist in the current config to prevent injection.
    const merged = { ...current } as Record<string, unknown>;
    for (const [key, val] of Object.entries(body)) {
      if (val && typeof val === 'object' && !Array.isArray(val) &&
          key in merged && merged[key] && typeof merged[key] === 'object') {
        (merged as Record<string, unknown>)[key] = {
          ...(merged[key] as Record<string, unknown>),
          ...(val as Record<string, unknown>),
        };
      }
    }
    setConfig(merged as ReturnType<typeof getConfig>);
    log.info('Settings updated via PATCH');
    return { ok: true };
  });

  // ── Logs & extracted routes ─────────────────────────
  registerLogRoutes(app, { runtimeLogDir: RUNTIME_LOG_DIR, runtimeLogPath: RUNTIME_LOG_PATH });
  registerArtifactRoutes(app, { storageRoot: ARTIFACT_STORAGE_ROOT, executorAgentKey: config.executor.agentKey });
  registerNodeCommandRoutes(app, { executorAgentKey: config.executor.agentKey });
  registerTodoRoutes(app);
  registerAgentTaskGraphRoutes(app);
  registerDiagnosticsRoutes(app);
  registerNodeRoutes(app);
  registerServiceRoutes(app, { serviceId: service.serviceId, serviceKind: 'gateway' });
  registerMCPRoutes(app);
  registerSkillRoutes(app, DEFAULT_WORKSPACE_ROOT);
  registerRuleRoutes(app, DEFAULT_WORKSPACE_ROOT);
  registerChatRoute(app, config, DEFAULT_WORKSPACE_ROOT, service.serviceId);

  // ── Feature routes ─────────────────────────────────
  registerMemoryRoutes(app);
  registerSessionRoutes(app);
  registerTraceRoutes(app);
  registerSseRoutes(app);
  registerTaskRoutes(app);
  registerRunRoutes(app);
  registerIntegrationRoutes(app, config, DEFAULT_WORKSPACE_ROOT);
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

  // Run ordered migrations before any ensure*Store() calls.
  // Migrations are idempotent (CREATE TABLE IF NOT EXISTS within each file).
  const migrateResult = await migrateDir(getMigrateDir(config), getDb());
  if (migrateResult.applied.length > 0) {
    log.info(`Migrations applied: ${migrateResult.applied.join(', ')}`);
  }
  if (migrateResult.errors.length > 0) {
    log.warn(`Migration errors: ${migrateResult.errors.join('; ')}`);
  }

  await ensureTodoStore();
  await ensureIdempotencyStore();
  await ensureExecutorNodeStore();
  await ensureServiceInstanceStore();
  await heartbeatGatewayService(service);
  await ensureTaskRunStore();
  await ensureRunSpecStore();
  await ensureAgentTaskGraphStore();
  await ensureMemoryStore();
  await ensureMemoryCompactionStore();
  await ensureProceduralCandidateStore();
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
    // Write expired task runs to dead-letter queue for operator visibility
    import('@los/agent/dead-letter').then(({ writeDeadLetterEvent }) =>
      writeDeadLetterEvent({
        taskRunId: task.id,
        runSpecId: task.runSpecId ?? undefined,
        reason: 'lease_expired',
        eventPayload: {
          taskStatus: 'failed',
          recoveryReason: 'gateway_startup_recovery',
          sessionId: task.sessionId,
        },
      }).catch(() => undefined)
    ).catch(() => undefined);
    // Transition parent run_spec to blocked so the failure is visible
    // in the run-state-vocabulary operator_attention projection.
    if (task.runSpecId) {
      await transitionExecutionState({
        entityType: 'run_spec',
        entityId: task.runSpecId,
        to: 'blocked',
        sessionId: task.sessionId,
        reason: `task_run ${task.id} recovered as failed: gateway_startup_recovery`,
      }).catch(() => undefined);
    }
  }

  const agentTaskRecovery = await recoverExpiredAgentTasksWithAdvisoryLock('gateway_startup_recovery');
  if (agentTaskRecovery.lockAcquired && agentTaskRecovery.recovered.length > 0) {
    log.info(`Gateway startup recovered ${agentTaskRecovery.recovered.length} expired agent task(s)`);
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

  // Daily memory retention + integrity + auto-compact (run at startup + every 24h)
  const RETENTION_MS = 24 * 60 * 60 * 1000;
  const runMemoryMaintenance = async () => {
    import('@los/memory').then(async ({ applyRetentionPolicy, checkMemoryIntegrity, compactSession, ensureMemoryCompactionStore }) => {
      const retention = await applyRetentionPolicy().catch((err) => {
        log.warn(`Memory retention failed: ${err.message ?? String(err)}`);
        return null;
      });
      if (retention && (retention.archivedCount > 0 || retention.deletedCount > 0)) {
        log.info(`Memory retention: archived ${retention.archivedCount}, deleted ${retention.deletedCount}`);
      }
      const integrity = await checkMemoryIntegrity().catch((err) => {
        log.warn(`Memory integrity check failed: ${err.message ?? String(err)}`);
        return null;
      });
      if (integrity && integrity.checks && integrity.checks.length > 0) {
        const failed = integrity.checks.filter(c => c.severity === 'error');
        if (failed.length > 0) {
          log.warn(`Memory integrity: ${failed.length} error(s) — ${failed.slice(0, 3).map(c => c.name).join('; ')}`);
        }
      }
      // Auto-compact uncompacted sessions (>1h old, up to 10)
      try {
        const { getDb } = await import('@los/infra/db');
        await ensureMemoryCompactionStore();
        const db = getDb();
        const rows = await db.query<{ session_id: string }>(
          `SELECT DISTINCT o.session_id
           FROM observations o
           LEFT JOIN memory_compactions mc ON o.session_id = mc.session_id
           WHERE o.session_id IS NOT NULL
             AND mc.id IS NULL
             AND o.created_at < now() - INTERVAL '1 hour'
           LIMIT 10`,
        );
        const sessionIds = rows.rows.map(r => r.session_id).filter(Boolean);
        if (sessionIds.length > 0) {
          let compacted = 0;
          for (const sessionId of sessionIds) {
            try {
              const result = await compactSession({ sessionId });
              if (result) compacted += 1;
            } catch (err) {
              log.warn(`Auto-compact failed for session ${sessionId}: ${err instanceof Error ? err.message : String(err)}`);
            }
          }
          if (compacted > 0) log.info(`Auto-compact: compacted ${compacted}/${sessionIds.length} session(s)`);
        }
      } catch (err) {
        log.warn(`Auto-compact maintenance failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }).catch((err) => {
      log.warn(`Memory maintenance import failed: ${err instanceof Error ? err.message : String(err)}`);
    });
  };
  // Run once at startup, then daily
  const memoryMaintenanceTimeout = setTimeout(runMemoryMaintenance, 10_000);
  const retentionTimer = setInterval(runMemoryMaintenance, RETENTION_MS);
  app.addHook('onClose', async () => {
    clearTimeout(memoryMaintenanceTimeout);
    clearInterval(retentionTimer);
  });

  // Governance sweep — seed jobs + run due audits (daily, offset from memory maintenance)
  const GOVERNANCE_SWEEP_MS = 24 * 60 * 60 * 1000;
  const runGovernanceMaintenance = async () => {
    import('@los/agent').then(async ({ ensureGovernanceJobStore, seedGovernanceJobs, runGovernanceSweep }) => {
      try {
        await ensureGovernanceJobStore();
        await seedGovernanceJobs();
        const result = await runGovernanceSweep({ dryRun: false });
        if (result.jobsRun > 0) {
          log.info(`Governance sweep: ${result.jobsRun} job(s) run, ${result.findingsCreated} finding(s)`);
        }
        if (result.errors.length > 0) {
          log.warn(`Governance sweep errors: ${result.errors.join('; ')}`);
        }
      } catch (err) {
        log.warn(`Governance sweep failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }).catch((err) => {
      log.warn(`Governance sweep import failed: ${err instanceof Error ? err.message : String(err)}`);
    });
  };
  const governanceTimeout = setTimeout(runGovernanceMaintenance, 30_000);
  const governanceTimer = setInterval(runGovernanceMaintenance, GOVERNANCE_SWEEP_MS);
  app.addHook('onClose', async () => {
    clearTimeout(governanceTimeout);
    clearInterval(governanceTimer);
  });

  await app.listen({ port: p, host: h });
  log.info(`Gateway ${service.serviceId} listening on http://${h}:${p}`);
  return app;
}

if (process.argv[1]?.endsWith('server.ts') || process.argv[1]?.endsWith('server.js')) {
  void startServer().catch((error) => {
    console.error('GATEWAY FATAL:', error instanceof Error ? `${error.message}\n${error.stack}` : String(error));
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
