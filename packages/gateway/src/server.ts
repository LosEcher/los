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
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getConfig, loadConfig, printConfigDiagnostics } from '@los/infra/config';
import { initDb } from '@los/infra/db';
import { printOnboardingReport, discoverAll, type DiscoveredProvider } from '@los/infra/discovery';
import { getLogger } from '@los/infra/logger';
import { createProvider } from '@los/agent';
import { registerLogRoutes } from './log-routes.js';
import { registerArtifactRoutes } from './artifact-routes.js';
import { registerNodeRoutes } from './node-routes.js';
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
  recoverExpiredTaskRuns,
  updateTaskRun,
} from '@los/agent/task-runs';
import { ensureExecutorNodeStore } from '@los/agent/executor-nodes';
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
const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_WORKSPACE_ROOT = resolve(__dirname, '../../..');
const WORKSPACE_ROOT = resolve(__dirname, '../../..');
const WEB_DIST_ROOT = resolve(__dirname, '../../web/dist');
const WEB_INDEX_PATH = join(WEB_DIST_ROOT, 'index.html');
const LEGACY_INDEX_PATH = resolve(__dirname, '../src/index.html');
const RUNTIME_LOG_DIR = join(WORKSPACE_ROOT, '.los-runtime');
const RUNTIME_LOG_PATH = join(RUNTIME_LOG_DIR, 'gateway.log');
const ARTIFACT_STORAGE_ROOT = join(WORKSPACE_ROOT, '.los-runtime', 'artifacts');

export async function createServer() {
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
      try {
        const provider = createProvider(providerName);
        if (!provider.listModels) {
          return {
            provider: providerName,
            ok: false,
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
    return { status: 'ok', uptime: process.uptime() };
  });

  // ── Logs ─────────────────────────────────────────────

  registerLogRoutes(app, {
    runtimeLogDir: RUNTIME_LOG_DIR,
    runtimeLogPath: RUNTIME_LOG_PATH,
  });
  registerArtifactRoutes(app, {
    storageRoot: ARTIFACT_STORAGE_ROOT,
  });
  registerTodoRoutes(app);
  registerNodeRoutes(app);

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
  await initDb(config.databaseUrl);
  await ensureTodoStore();
  await ensureIdempotencyStore();
  await ensureExecutorNodeStore();
  await ensureTaskRunStore();
  const recoveredTasks = await recoverExpiredTaskRuns('gateway_startup_recovery');
  for (const task of recoveredTasks) {
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

  const app = await createServer();

  const p = port ?? config.server.port;
  const h = host ?? config.server.host;

  await app.listen({ port: p, host: h });
  log.info(`Gateway listening on http://${h}:${p}`);

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
  };
}

function sanitizeErrorMessage(message: string): string {
  return message.replace(/sk-[A-Za-z0-9_-]{8,}/g, 'sk-REDACTED');
}

function selectAgentModelProviders(config: ReturnType<typeof getConfig>): string[] {
  const core = new Set(['deepseek', 'openai', 'codex', 'packycode']);
  const configured = Object.entries(config.providers)
    .filter(([name, provider]) => core.has(name) && provider.enabled)
    .map(([name]) => name);
  if (configured.length > 0) return configured;
  return [config.agent.defaultProvider];
}
