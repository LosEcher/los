/**
 * @los/gateway — Fastify HTTP server with SSE streaming.
 *
 * Inspired by Hermes Web UI (BFF pattern) and Open WebUI.
 * Routes: POST /chat (SSE stream), GET/POST /memory, GET /health.
 */

import Fastify from 'fastify';
import cors from '@fastify/cors';
import fastifyWebsocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { hostname } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import gatewayPackage from '../package.json' with { type: 'json' };
import { getConfig, setConfig, loadConfig, printConfigDiagnostics } from '@los/infra/config';
import { initDb, getDb } from '@los/infra/db';
import { getLogger } from '@los/infra/logger';
import { migrateDir } from '@los/infra/migrate';
import { getMigrateDir } from '@los/infra/config';
import { printOnboardingReport } from '@los/infra/discovery';
import { registerLogRoutes } from './routes/infrastructure/log-routes.js';
import { registerArtifactRoutes } from './routes/tools/artifact-routes.js';
import { registerNodeCommandRoutes } from './routes/orchestration/node-command-routes.js';
import { registerNodeRoutes } from './routes/infrastructure/node-routes.js';
import { registerServiceRoutes } from './routes/infrastructure/service-routes.js';
import { registerMCPRoutes } from './routes/tools/mcp-routes.js';
import { registerSkillRoutes } from './routes/tools/skill-routes.js';
import { registerRuleRoutes } from './routes/tools/rule-routes.js';
import { registerTodoRoutes } from './routes/data/todo-routes.js';
import { registerSaaSTodoRoutes } from './routes/data/saas-todo-routes.js';
import { registerAgentTaskGraphRoutes } from './routes/orchestration/agent-task-graph-routes.js';
import { registerDiagnosticsRoutes } from './routes/infrastructure/diagnostics-routes.js';
import { registerGovernanceRoutes } from './routes/infrastructure/governance-routes.js';
import { ensureAllStores } from './bootstrap.js';
import { registerChatRoute } from './chat-route.js';
import { registerOpenAICompatibleRoute } from './openai-compat-route.js';
import { getRequestContext, registerRequestContext } from './request-context.js';
import authMiddleware from './auth-middleware.js';
import { registerSecurityHeaders } from './security-headers.js';
import { createRateLimiter } from './rate-limit.js';
import { registerServerMaintenance } from './server-maintenance.js';
import { registerProviderRoutes } from './routes/providers/provider-routes.js';
import { registerMemoryRoutes } from './routes/data/memory-routes.js';
import { registerSecurityRoutes } from './routes/data/security-routes.js';
import { registerSessionRoutes } from './routes/data/session-routes.js';
import { registerTraceRoutes } from './routes/data/trace-routes.js';
import { registerSseRoutes, setupLiveEventPush, registerLiveEventRoutes } from './routes/streaming/sse-routes.js';
import { registerOperatorEvents } from './routes/streaming/operator-events-sse.js';
import { registerWsRoutes } from './routes/streaming/ws-routes.js';
import { registerTaskRoutes } from './routes/orchestration/task-routes.js';
import { registerRunRoutes } from './routes/orchestration/run-routes.js';
import { registerProjectRoutes } from './routes/infrastructure/project-routes.js';
import { registerFileSyncRoutes } from './routes/infrastructure/file-sync-routes.js';
import { registerIntegrationRoutes } from './routes/data/integration-routes.js';
import { registerCommunicationRoutes } from './routes/data/communication-routes.js';
import { registerRuntimeAdapterRoutes } from './routes/orchestration/runtime-adapter-routes.js';
import { registerToolGateRoutes } from './routes/orchestration/tool-gate-routes.js';
import { recoverExpiredTaskRunsWithAdvisoryLock } from '@los/agent/task-runs';
import { recoverExpiredAgentTasksWithAdvisoryLock } from '@los/agent/agent-task-graph';
import { loadServiceInstance, upsertServiceInstanceHeartbeat } from '@los/agent/service-instances';
import { seedLosPlanningTodos } from '@los/agent/todos';
import { ensureSkillStore, upsertSkill, loadSkillsFromDir } from '@los/agent/skills';
import { ensureRuleStore, upsertRule, loadRulesFromDir } from '@los/agent/rules';
import { appendSessionEvent } from '@los/agent/session-events';
import { transitionExecutionState } from '@los/agent/execution-store';
import { readExecutionOutboxHealth } from '@los/agent/execution-outbox';
import { startOtelBridge } from '@los/agent/runtime-adapter';
import { MessageRouter, createBuiltinHandlers } from '@los/agent/message-router';
import { dispatchTodo as dispatchTodoCore, DispatchError } from '@los/agent/todo-dispatch';
import { getDefaultProjectId, getProject } from './project-store.js';
import { getSymbolCacheMetrics } from './chat-cbm-symbol-cache.js';

const log = getLogger('gateway');
const SERVICE_HEARTBEAT_MS = 10_000;
const __dirname = dirname(fileURLToPath(import.meta.url));
function resolveDefaultWorkspaceRoot(): string {
  // Priority: LOS_DEFAULT_WORKSPACE_ROOT env → default project binding → build-time fallback
  if (process.env.LOS_DEFAULT_WORKSPACE_ROOT) {
    return resolve(process.env.LOS_DEFAULT_WORKSPACE_ROOT);
  }
  try {
    const defaultId = getDefaultProjectId();
    if (defaultId) {
      const binding = getProject(defaultId);
      if (binding?.workspacePath) return binding.workspacePath;
    }
  } catch {
    // project-store may not be available during early bootstrap
  }
  return resolve(__dirname, '../../..');
}

const DEFAULT_WORKSPACE_ROOT = resolveDefaultWorkspaceRoot();
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
  const app = Fastify({
    logger: false,
  });

  await app.register(cors, { origin: config.server.corsOrigin });
  await app.register(fastifyWebsocket);
  registerRequestContext(app, config);
  await authMiddleware(app, { config });
  registerSecurityHeaders(app, { hsts: false });

  // Rate limit for LLM-heavy endpoints
  const chatLimiter = createRateLimiter({
    max: 30,
    windowMs: 60_000,
    message: 'Too many chat requests. Please wait and try again.',
  });
  app.addHook('onClose', async () => {
    clearInterval(chatLimiter.cleanupInterval);
  });

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
    const [current, outbox] = await Promise.all([
      loadServiceInstance(service.serviceId).catch(() => null),
      readExecutionOutboxHealth().catch(() => null),
    ]);
    return {
      status: 'ok',
      uptime: process.uptime(),
      serviceId: service.serviceId,
      serviceKind: 'gateway',
      ready: current?.readiness.ready ?? false,
      blockers: current?.readiness.blockers ?? ['service:not_registered'],
      outbox,
      cbmSymbolCache: getSymbolCacheMetrics(),
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
  registerSaaSTodoRoutes(app);
  registerAgentTaskGraphRoutes(app);
  registerDiagnosticsRoutes(app);
  registerGovernanceRoutes(app);
  registerNodeRoutes(app);
  registerServiceRoutes(app, { serviceId: service.serviceId, serviceKind: 'gateway' });
  registerMCPRoutes(app);
  registerSkillRoutes(app, DEFAULT_WORKSPACE_ROOT);
  registerRuleRoutes(app, DEFAULT_WORKSPACE_ROOT);

  // ── MessageRouter (unified inbound routing) ─────────────
  const messageRouter = new MessageRouter({
    handlers: createBuiltinHandlers({
      config,
      dispatchTodo: async (todoId, opts) => {
        try {
          const result = await dispatchTodoCore(todoId, { force: opts?.force });
          return { ok: true, status: 200, body: result };
        } catch (err) {
          if (err instanceof DispatchError) {
            return { ok: false, status: err.status, body: { error: err.code, message: err.message, ...(err.detail ?? {}) } };
          }
          return { ok: false, status: 500, body: { error: 'internal', message: (err as Error).message } };
        }
      },
    }),
    defaultChannelId: 'direct-http',
  });

  registerChatRoute(app, config, DEFAULT_WORKSPACE_ROOT, service.serviceId, chatLimiter.hook, messageRouter);
  registerOpenAICompatibleRoute(app, config, DEFAULT_WORKSPACE_ROOT, service.serviceId, messageRouter);

  // ── Feature routes ─────────────────────────────────
  registerMemoryRoutes(app);
  registerSecurityRoutes(app);
  registerSessionRoutes(app);
  registerTraceRoutes(app);
  registerSseRoutes(app, service.serviceId);
  registerWsRoutes(app, service.serviceId);
  registerTaskRoutes(app);
  registerRunRoutes(app);
  registerIntegrationRoutes(app, config, DEFAULT_WORKSPACE_ROOT);
  registerCommunicationRoutes(app);
  registerRuntimeAdapterRoutes(app, messageRouter);
  registerToolGateRoutes(app);
  setupLiveEventPush(app);
  registerLiveEventRoutes(app);
  registerOperatorEvents(app);

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

  // Materialize every runtime table via ensure*Store in one dependency-safe
  // pass. This self-heals any migration-vs-ensure drift at startup (no
  // "first feature use patches the schema" window) and guarantees all 32
  // tables exist before any request is served. See packages/gateway/src/bootstrap.ts.
  await ensureAllStores();
  await heartbeatGatewayService(service);
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
  await seedSkills(DEFAULT_WORKSPACE_ROOT);
  await seedRules(DEFAULT_WORKSPACE_ROOT);

  // ── Start OTel bridge for external agent telemetry ingestion ──
  let otelBridgeStop: (() => Promise<void>) | null = null;
  try {
    const otelBridge = await startOtelBridge({ source: 'gateway' });
    otelBridgeStop = otelBridge.stop;
    log.info(`OTel bridge auto-started on port ${otelBridge.port}`);
  } catch (err) {
    log.warn(`OTel bridge auto-start failed (non-fatal): ${(err as Error).message}`);
  }
  console.log(await printOnboardingReport());
  console.log(printConfigDiagnostics(config));

  // ── CBM code graph availability check (best-effort) ──
  if (config.memory?.codeGraph?.enabled) {
    try {
      const { CBMClient } = await import('@los/memory');
      const cbm = CBMClient.createDefault({
        command: config.memory.codeGraph.cbmCommand,
        args: config.memory.codeGraph.cbmArgs,
      });
      await cbm.connect();
      const metrics = cbm.getMetrics();
      log.info(`CBM code graph: available (${metrics.successes} queries ok)`);
      await cbm.close();
    } catch (err) {
      log.warn(`CBM code graph: unavailable — ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const app = await createServer(service);
  const heartbeat = setInterval(() => {
    heartbeatGatewayService(service).catch((err) => log.warn(`service heartbeat failed: ${err.message ?? String(err)}`));
  }, SERVICE_HEARTBEAT_MS);
  app.addHook('onClose', async () => {
    clearInterval(heartbeat);
    if (otelBridgeStop) {
      await otelBridgeStop().catch((err) => log.warn(`OTel bridge stop failed: ${(err as Error).message}`));
    }
  });

  // Register maintenance timers: orphan reaper, memory retention/integrity/auto-compact, governance sweep
  registerServerMaintenance(app, service, config, { executorAgentKey: config.executor.agentKey });

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

// ── Skills/Rules seed ───────────────────────────────────

async function seedSkills(workspaceRoot: string) {
  try {
    await ensureSkillStore();
    const projectSkills = loadSkillsFromDir('project', workspaceRoot);
    const globalSkills = loadSkillsFromDir('global');
    // Also scan Claude Code's directory (cross-tool compatibility)
    const ccGlobalSkills = loadClaudeSkills(join(home(), '.claude', 'skills'), 'global');
    const ccProjSkills = loadClaudeSkills(join(workspaceRoot, '.claude', 'skills'), 'project');
    const all = [...projectSkills, ...globalSkills, ...ccGlobalSkills, ...ccProjSkills];
    for (const s of all) {
      await upsertSkill(s).catch(err => log.warn(`skill upsert failed for '${s.name}': ${(err as Error).message}`));
    }
    if (all.length > 0) {
      log.info(`Seeded ${all.length} skills (${projectSkills.length} project, ${globalSkills.length} global, ${ccGlobalSkills.length} cc-global, ${ccProjSkills.length} cc-project)`);
    }
  } catch (err) {
    log.warn(`Skills seed failed: ${(err as Error).message}`);
  }
}

async function seedRules(workspaceRoot: string) {
  try {
    await ensureRuleStore();
    const projectRules = loadRulesFromDir('project', workspaceRoot);
    const globalRules = loadRulesFromDir('global');
    // Also scan Claude Code's directory (cross-tool compatibility)
    const ccGlobalRules = loadClaudeRules(join(home(), '.claude', 'rules'), 'global');
    const ccProjRules = loadClaudeRules(join(workspaceRoot, '.claude', 'rules'), 'project');
    const all = [...projectRules, ...globalRules, ...ccGlobalRules, ...ccProjRules];
    for (const r of all) {
      await upsertRule(r).catch(err => log.warn(`rule upsert failed for '${r.name}': ${(err as Error).message}`));
    }
    if (all.length > 0) {
      log.info(`Seeded ${all.length} rules (${projectRules.length} project, ${globalRules.length} global, ${ccGlobalRules.length} cc-global, ${ccProjRules.length} cc-project)`);
    }
  } catch (err) {
    log.warn(`Rules seed failed: ${(err as Error).message}`);
  }
}

function home(): string {
  return process.env.HOME ?? process.env.USERPROFILE ?? '/tmp';
}

function loadClaudeSkills(dir: string, scope: 'global' | 'project'): Array<{ name: string; content: string; metadata: Record<string, unknown>; enabled: boolean }> {
  if (!existsSync(dir)) return [];
  const results: Array<{ name: string; content: string; metadata: Record<string, unknown>; enabled: boolean }> = [];
  for (const entry of readdirSync(dir)) {
    // Claude Code skills are directories with SKILL.md, or single .md files
    const entryPath = join(dir, entry);
    let mdPath: string;
    if (statSync(entryPath).isDirectory()) {
      const skillMd = join(entryPath, 'SKILL.md');
      if (existsSync(skillMd)) {
        mdPath = skillMd;
      } else {
        continue;
      }
    } else if (entry.endsWith('.md')) {
      mdPath = entryPath;
    } else {
      continue;
    }
    try {
      const raw = readFileSync(mdPath, 'utf-8');
      const name = entry.replace(/\.md$/i, '');
      results.push({ name, content: raw, metadata: { scope, skillLayer: scope === 'global' ? 'user' : 'project' }, enabled: true });
    } catch {
      // skip unreadable files
    }
  }
  return results;
}

function loadClaudeRules(dir: string, scope: 'global' | 'project'): Array<{ name: string; content: string; severity: 'warn'; enforcementMode: 'advisory'; status: 'active'; metadata: Record<string, unknown> }> {
  if (!existsSync(dir)) return [];
  const results: Array<{ name: string; content: string; severity: 'warn'; enforcementMode: 'advisory'; status: 'active'; metadata: Record<string, unknown> }> = [];
  for (const entry of readdirSync(dir)) {
    if (!entry.endsWith('.md')) continue;
    const mdPath = join(dir, entry);
    try {
      const raw = readFileSync(mdPath, 'utf-8');
      const name = entry.replace(/\.md$/i, '');
      results.push({ name, content: raw, severity: 'warn', enforcementMode: 'advisory', status: 'active', metadata: { scope, ruleLayer: scope === 'global' ? 'user' : 'project' } });
    } catch {
      // skip unreadable files
    }
  }
  return results;
}

// ── Service identity ───────────────────────────────────

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
    version: getConfig().server.version ?? gatewayPackage.version,
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
