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
import { registerSkillRoutes } from './skill-routes.js';
import { registerRuleRoutes } from './rule-routes.js';
import { registerTodoRoutes } from './todo-routes.js';
import { registerAgentTaskGraphRoutes } from './agent-task-graph-routes.js';
import { ensureIdempotencyStore } from './idempotency.js';
import { registerChatRoute } from './chat-route.js';
import { getRequestContext, registerRequestContext } from './request-context.js';
import { cancelScheduledTask } from '@los/agent/scheduler';
import {
  listLatestProviderCompatEvidence,
  listProviderCompatEvidence,
  listProviderPromotionDecisions,
  enforceProviderPromotionDecision,
  recordProviderPromotionDecision,
  applyToolCallRecoveryTransitionForRunSpec,
  importExternalToolSummary,
  listExternalToolSummaries,
  readRunStateProjection,
  listVerificationRecordsForSession,
  readRuntimeEvidenceGraph,
  readToolCallRecoveryForRunSpec,
  runVerificationRecordsForRunSpec,
} from '@los/agent';
import { ensureSessionStore, loadSession, listSessions, saveSession, deleteSession, type SessionRecord } from '@los/agent/session';
import { ensureRunSpecStore, loadRunSpec, listRunSpecs } from '@los/agent/run-specs';
import { getPool } from '@los/infra/db';
import {
  ensureTaskRunStore,
  loadTaskRun,
  listTaskRuns,
  listTaskRunsForSession,
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
  loadSessionEvent,
  listSessionEvents,
  listSessionEventsSince,
  getSessionObservability,
} from '@los/agent/session-events';
import {
  ensureMemoryStore, addObservation, searchObservations,
  getStats, syncMemoryMd, deleteObservation, updateObservation
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
    const compatEvidence = await listLatestProviderCompatEvidence().catch(() => []);
    return {
      ...report,
      providers: report.providers.map(provider => sanitizeProviderDiscovery(provider, compatEvidence)),
    };
  });

  app.get('/providers/compat-evidence', async (req) => {
    const query = req.query as { provider?: string; model?: string; limit?: string };
    const evidence = await listProviderCompatEvidence({
      provider: normalizeOptionalString(query.provider),
      model: normalizeOptionalString(query.model),
      limit: normalizeBoundedInteger(query.limit, 100, 1, 1000),
    });
    return {
      count: evidence.length,
      evidence: evidence.map(sanitizeProviderCompatEvidence),
    };
  });

  app.get('/providers/promotion-decisions', async (req) => {
    const query = req.query as { provider?: string; model?: string; limit?: string };
    const decisions = await listProviderPromotionDecisions({
      provider: normalizeOptionalString(query.provider),
      model: normalizeOptionalString(query.model),
      limit: normalizeBoundedInteger(query.limit, 100, 1, 1000),
    });
    return {
      count: decisions.length,
      decisions,
    };
  });

  app.post('/providers/promotion-decisions', async (req, reply) => {
    const body = asRecord(req.body);
    try {
      const decision = await recordProviderPromotionDecision({
        action: parseProviderPromotionAction(body.action),
        provider: normalizeOptionalString(body.provider),
        model: normalizeOptionalString(body.model),
        probeId: normalizeOptionalString(body.probeId),
        targetLabel: normalizeOptionalString(body.targetLabel),
        evidenceId: normalizeOptionalString(body.evidenceId),
        reason: normalizeOptionalString(body.reason) ?? '',
        actor: normalizeOptionalString(body.actor),
      });
      return { decision };
    } catch (err) {
      return reply.status(422).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post('/providers/promotion-decisions/enforce', async (req, reply) => {
    const body = asRecord(req.body);
    try {
      const decision = await enforceProviderPromotionDecision({
        id: normalizeOptionalString(body.id) ?? '',
        actor: normalizeOptionalString(body.actor),
      });
      return { decision };
    } catch (err) {
      return reply.status(422).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.get('/external-summaries', async (req) => {
    const query = req.query as { tool?: string; sourceKind?: string; limit?: string; includeExpired?: string };
    const summaries = await listExternalToolSummaries({
      tool: normalizeOptionalString(query.tool),
      sourceKind: normalizeOptionalString(query.sourceKind),
      limit: normalizeBoundedInteger(query.limit, 100, 1, 1000),
      includeExpired: query.includeExpired === 'true',
    });
    return {
      count: summaries.length,
      summaries,
    };
  });

  app.post('/external-summaries', async (req, reply) => {
    try {
      const summary = await importExternalToolSummary(req.body as never);
      return reply.status(201).send({ summary });
    } catch (err) {
      return reply.status(422).send({ error: err instanceof Error ? err.message : String(err) });
    }
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

  // ── Workspace ────────────────────────────────────────

  app.get('/workspace', async () => ({
    workspaceRoot: DEFAULT_WORKSPACE_ROOT,
    cwd: process.cwd(),
  }));

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

  app.get('/settings', async () => {
    return {
      server: {
        port: config.server.port,
        host: config.server.host,
      },
      agent: {
        defaultProvider: config.agent.defaultProvider,
        defaultModel: config.agent.defaultModel,
        maxLoops: config.agent.maxLoops,
        sandboxMode: config.agent.sandboxMode,
      },
      memory: {
        ftsEnabled: config.memory.ftsEnabled,
        maxObservations: config.memory.maxObservations,
      },
      executor: {
        enabled: config.executor.enabled,
        nodeId: config.executor.nodeId,
        nodeUrl: config.executor.nodeUrl,
        meshNodeCount: config.executor.meshNodes.length,
      },
      providers: Object.entries(config.providers).map(([name, p]) => ({
        name,
        enabled: p.enabled ?? false,
        hasApiKey: typeof p.apiKey === 'string' && p.apiKey.length > 0,
        model: p.model ?? null,
        weight: p.weight ?? null,
      })),
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
  registerAgentTaskGraphRoutes(app);
  registerNodeRoutes(app);
  registerServiceRoutes(app, {
    serviceId: service.serviceId,
    serviceKind: 'gateway',
  });
  registerMCPRoutes(app);
  registerSkillRoutes(app, DEFAULT_WORKSPACE_ROOT);
  registerRuleRoutes(app, DEFAULT_WORKSPACE_ROOT);

  registerChatRoute(app, config, DEFAULT_WORKSPACE_ROOT);

  // ── Memory ────────────────────────────────────────────

  app.get('/memory', async (req) => {
    const query = req.query as {
      q?: string;
      kind?: string;
      source?: string;
      tag?: string;
      scope?: string;
      memoryLayer?: string;
      archived?: string;
      sessionId?: string;
      tenantId?: string;
      projectId?: string;
      userId?: string;
      requestId?: string;
      traceId?: string;
      limit?: string;
    };
    await ensureMemoryStore();
    const results = await searchObservations(query.q ?? '', {
      kind: query.kind,
      source: query.source,
      tag: query.tag,
      scope: query.scope,
      memoryLayer: query.memoryLayer,
      archived: parseOptionalBoolean(query.archived),
      sessionId: query.sessionId,
      tenantId: query.tenantId,
      projectId: query.projectId,
      userId: query.userId,
      requestId: query.requestId,
      traceId: query.traceId,
      limit: normalizeBoundedInteger(query.limit, 20, 1, 200),
    });
    return { count: results.length, results };
  });

  app.post('/memory', async (req) => {
    const { title, summary, kind, tags, content, metadata, source, sessionId, nodeId } = req.body as any;
    const context = getRequestContext(req);
    await ensureMemoryStore();
    const obs = await addObservation({
      title,
      summary,
      kind,
      tags: normalizeStringArray(tags),
      content,
      source,
      metadata: normalizeMemoryMetadata(metadata, {
        scope: 'project',
        memoryLayer: 'semantic',
        archived: false,
      }),
      sessionId: normalizeOptionalString(sessionId),
      tenantId: context.tenantId,
      projectId: context.projectId,
      userId: context.userId,
      nodeId: normalizeOptionalString(nodeId),
      requestId: context.requestId,
      traceId: context.traceId,
    });
    return obs;
  });

  app.patch('/memory/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = req.body as any;
    await ensureMemoryStore();
    const obs = await updateObservation(parseInt(id), {
      title: normalizeOptionalString(body.title),
      summary: normalizeOptionalString(body.summary),
      kind: normalizeOptionalString(body.kind),
      tags: body.tags === undefined ? undefined : normalizeStringArray(body.tags),
      content: normalizeOptionalString(body.content),
      metadata: body.metadata === undefined ? undefined : normalizeMemoryMetadata(body.metadata),
    });
    if (!obs) {
      reply.code(404);
      return { error: 'Not found' };
    }
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

  app.delete('/sessions/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    await ensureSessionStore();
    const deleted = await deleteSession(id);
    if (!deleted) return reply.status(404).send({ error: 'Not found' });
    return { ok: true };
  });

  app.post('/sessions/import', async (req, reply) => {
    const body = req.body as Record<string, unknown> | undefined;
    if (!body || typeof body.id !== 'string' || !body.id) {
      return reply.status(400).send({ error: 'session id is required' });
    }
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const turns = Array.isArray(body.turns) ? body.turns : [];
    const metadata = body.metadata && typeof body.metadata === 'object' && !Array.isArray(body.metadata)
      ? body.metadata as Record<string, unknown>
      : {};

    await ensureSessionStore();
    const existing = await loadSession(body.id);
    if (existing) {
      return reply.status(409).send({ error: 'session already exists', id: body.id });
    }

    await saveSession({
      id: body.id,
      createdAt: typeof body.createdAt === 'string' ? body.createdAt : new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      messages: messages as SessionRecord['messages'],
      turns: turns as SessionRecord['turns'],
      metadata: { ...metadata, imported: true, importedAt: new Date().toISOString() },
    });
    return { ok: true, id: body.id };
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

  app.get('/sessions/:id/verification', async (req) => {
    const { id } = req.params as { id: string };
    const records = await listVerificationRecordsForSession(id);
    return { sessionId: id, count: records.length, records };
  });

  // ── SSE Event Replay ──────────────────────────────────

  app.get('/sessions/:id/events/stream', async (req, reply) => {
    const { id } = req.params as { id: string };
    const since = Math.max(0, Number((req.query as { since?: string }).since ?? 0));

    await ensureSessionEventStore();
    await ensureTaskRunStore();

    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    const send = (event: string, data: unknown, eventId?: number) => {
      if (eventId !== undefined) reply.raw.write(`id: ${eventId}\n`);
      reply.raw.write(`event: ${event}\n`);
      reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    let lastId = since;
    let ended = false;

    const pollAndSend = async () => {
      if (ended) return;
      const events = await listSessionEventsSince(id, lastId, 100);
      for (const event of events) {
        // Map internal event types to stream events
        const streamType = event.type.includes('.') ? event.type : event.type;
        send(streamType, {
          id: event.id,
          sessionId: event.sessionId,
          turn: event.turn,
          type: event.type,
          source: event.source,
          model: event.model ?? null,
          toolName: event.toolName ?? null,
          usage: event.usage ?? null,
          payload: event.payload,
          createdAt: event.createdAt,
        }, event.id);
        lastId = event.id;
      }
      return events.length;
    };

    try {
      // Send historical events first
      await pollAndSend();

      // Check if there's an active task for this session
      const activeTasks = await listTaskRunsForSession(id, 5);
      const active = activeTasks.find(t => t.status === 'queued' || t.status === 'running');

      if (active) {
        send('session.live', {
          sessionId: id,
          taskRunId: active.id,
          status: active.status,
          message: `Session has active task. Streaming live events...`,
        });

        // Poll for new events while task is running
        const interval = setInterval(async () => {
          try {
            const count = await pollAndSend();
            const task = await loadTaskRun(active.id);
            if (!task || !['queued', 'running'].includes(task.status)) {
              ended = true;
              clearInterval(interval);
              send('session.completed', {
                sessionId: id,
                taskRunId: active.id,
                status: task?.status ?? 'unknown',
              });
              reply.raw.end();
            }
          } catch {
            clearInterval(interval);
            reply.raw.end();
          }
        }, 1000);

        req.raw.on('close', () => {
          clearInterval(interval);
        });
      } else {
        send('session.completed', {
          sessionId: id,
          message: 'No active task. All events delivered.',
        });
        reply.raw.end();
      }
    } catch (err: any) {
      send('error', { message: err?.message ?? String(err) });
      reply.raw.end();
    }
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

  // ── Run Specs ─────────────────────────────────────────

  app.get('/runs', async () => {
    await ensureRunSpecStore();
    return await listRunSpecs();
  });

  app.get('/runs/:id/events', async (req, reply) => {
    const { id } = req.params as { id: string };
    const query = req.query as { since?: string; limit?: string };
    const since = normalizeNonNegativeInteger(query.since, 0);
    const limit = normalizeBoundedInteger(query.limit, 200, 1, 10000);

    await ensureRunSpecStore();
    await ensureSessionEventStore();
    const runSpec = await loadRunSpec(id);
    if (!runSpec) return reply.status(404).send({ error: 'Not found' });

    const events = await listSessionEventsSince(runSpec.sessionId, since, limit);
    return {
      runSpecId: runSpec.id,
      sessionId: runSpec.sessionId,
      since,
      count: events.length,
      nextSince: events.at(-1)?.id ?? since,
      events,
    };
  });

  app.get('/runs/:id/inspect', async (req, reply) => {
    const { id } = req.params as { id: string };
    const [graph, state] = await Promise.all([
      readRuntimeEvidenceGraph(id),
      readRunStateProjection(id),
    ]);
    if (!graph) return reply.status(404).send({ error: 'Not found' });
    return {
      ...graph,
      state,
    };
  });

  app.get('/runs/:id/state', async (req, reply) => {
    const { id } = req.params as { id: string };
    const state = await readRunStateProjection(id);
    if (!state) return reply.status(404).send({ error: 'Not found' });
    return state;
  });

  app.post('/runs/:id/recover', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = asRecord(req.body);
    await ensureRunSpecStore();
    const runSpec = await loadRunSpec(id);
    if (!runSpec) return reply.status(404).send({ error: 'Not found' });
    const action = parseRecoveryTransitionAction(body.action ?? body.intent);
    if (body.apply === true) {
      if (!action) {
        return reply.status(400).send({ error: 'apply requires --intent cancel or --intent operator-attention' });
      }
      return await applyToolCallRecoveryTransitionForRunSpec(id, {
        action,
        reason: normalizeOptionalString(body.reason),
        actor: normalizeOptionalString(body.actor),
        staleMs: normalizeOptionalNonNegativeInteger(body.staleMs),
        cancelLiveTaskRun: cancelScheduledTask,
      });
    }
    return await readToolCallRecoveryForRunSpec(id, {
      intent: body.intent === 'cancel' ? 'cancel' : 'recover',
      staleMs: normalizeOptionalNonNegativeInteger(body.staleMs),
    });
  });

  app.post('/runs/:id/verify', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = asRecord(req.body);
    await ensureRunSpecStore();
    const runSpec = await loadRunSpec(id);
    if (!runSpec) return reply.status(404).send({ error: 'Not found' });
    return await runVerificationRecordsForRunSpec(id, {
      cwd: normalizeOptionalString(body.cwd),
      timeoutMs: normalizeOptionalNonNegativeInteger(body.timeoutMs),
      outputLimit: normalizeOptionalNonNegativeInteger(body.outputLimit),
      includeFailed: body.includeFailed === false ? false : undefined,
    });
  });

  app.get('/runs/:id', async (req) => {
    const { id } = req.params as { id: string };
    await ensureRunSpecStore();
    const runSpec = await loadRunSpec(id);
    if (!runSpec) return { error: 'Not found' };
    return runSpec;
  });

  // ── Live Event Push (PG LISTEN/NOTIFY) ────────────────

  const liveClients = new Map<string, Set<(eventId: number, data: string) => void>>();

  // Start PG LISTEN for session_events channel
  try {
    const pool = getPool();
    const listenClient = await pool.connect();
    await listenClient.query('LISTEN session_events');
    listenClient.on('notification', (msg) => {
      void (async () => {
        if (msg.channel !== 'session_events') return;
        const payload = parseLiveSessionEventNotification(msg.payload);
        if (!payload) return;
        const subs = liveClients.get(payload.sessionId);
        if (!subs || subs.size === 0) return;

        const event = await loadSessionEvent(payload.sessionId, payload.eventId);
        if (!event) return;
        const data = JSON.stringify(event);
        for (const send of subs) {
          try { send(event.id, data); } catch {}
        }
      })().catch((err) => {
        log.warn(`PG LISTEN notification handling failed: ${err?.message ?? String(err)}`);
      });
    });
    listenClient.on('error', (err) => {
      log.warn(`PG LISTEN client error: ${err?.message ?? String(err)}`);
    });
    app.addHook('onClose', async () => {
      try {
        await listenClient.query('UNLISTEN session_events');
      } catch {}
      listenClient.release();
    });
    log.info('PG LISTEN active on session_events');
  } catch (err: any) {
    log.warn(`PG LISTEN setup failed (live push disabled): ${err.message ?? String(err)}`);
  }

  app.get('/sessions/:id/events/live', async (req, reply) => {
    const { id } = req.params as { id: string };
    const since = Math.max(0, Number((req.query as { since?: string }).since ?? 0));

    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    const send = (event: string, data: string) => {
      reply.raw.write(`event: ${event}\ndata: ${data}\n\n`);
    };

    // Send any events since the given ID
    try {
      await ensureSessionEventStore();
      const events = await listSessionEventsSince(id, since, 100);
      for (const evt of events) {
        reply.raw.write(`id: ${evt.id}\n`);
        send('session_event', JSON.stringify(evt));
      }
    } catch {}

    // Register for live push
    const handler = (eventId: number, data: string) => {
      reply.raw.write(`id: ${eventId}\n`);
      send('session_event', data);
    };

    if (!liveClients.has(id)) liveClients.set(id, new Set());
    liveClients.get(id)!.add(handler);

    req.raw.on('close', () => {
      liveClients.get(id)?.delete(handler);
      if (liveClients.get(id)?.size === 0) liveClients.delete(id);
    });

    // Keep-alive ping every 15s
    const keepAlive = setInterval(() => {
      try { reply.raw.write(': keepalive\n\n'); } catch { clearInterval(keepAlive); }
    }, 15_000);

    req.raw.on('close', () => clearInterval(keepAlive));
  });

  // ── Sync MEMORY.md ────────────────────────────────────

  app.post('/memory/sync-md', async (req) => {
    const body = req.body as {
      workspaceRoot: string;
      scope?: string;
      memoryLayer?: string;
      archived?: boolean;
      projectId?: string;
    };
    await ensureMemoryStore();
    const observations = await searchObservations('', {
      limit: 50,
      scope: body.scope,
      memoryLayer: body.memoryLayer,
      archived: body.archived,
      projectId: body.projectId,
    });
    syncMemoryMd(body.workspaceRoot, observations);
    return { ok: true, count: observations.length };
  });

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
  await ensureRunSpecStore();
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

function parseRecoveryTransitionAction(value: unknown): 'cancel' | 'operator_attention' | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase().replace(/-/g, '_');
  if (normalized === 'cancel') return 'cancel';
  if (normalized === 'operator_attention') return 'operator_attention';
  return undefined;
}

function parseProviderPromotionAction(value: unknown): 'promote_required' | 'demote_advisory' {
  if (typeof value !== 'string') throw new Error('action is required');
  const normalized = value.trim().toLowerCase().replace(/-/g, '_');
  if (normalized === 'promote' || normalized === 'promote_required') return 'promote_required';
  if (normalized === 'demote' || normalized === 'demote_advisory') return 'demote_advisory';
  throw new Error('action must be promote_required or demote_advisory');
}

function normalizeStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map(item => String(item).trim()).filter(Boolean);
  }
  if (typeof value === 'string') {
    return value.split(',').map(item => item.trim()).filter(Boolean);
  }
  return [];
}

function normalizeMemoryMetadata(
  value: unknown,
  defaults: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    ...defaults,
    ...asRecord(value),
  };
}

function parseOptionalBoolean(value: unknown): boolean | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value === 'boolean') return value;
  if (typeof value !== 'string') return undefined;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return undefined;
}

function normalizeOptionalNonNegativeInteger(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return undefined;
  return Math.floor(parsed);
}

function normalizeNonNegativeInteger(value: unknown, fallback: number): number {
  const parsed = Number(value ?? fallback);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return Math.floor(parsed);
}

function normalizeBoundedInteger(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value ?? fallback);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function parseLiveSessionEventNotification(payload: string | undefined) {
  try {
    const parsed = JSON.parse(payload ?? '{}') as { sessionId?: unknown; eventId?: unknown };
    const eventId = Number(parsed.eventId);
    if (typeof parsed.sessionId !== 'string' || !Number.isFinite(eventId)) return null;
    return { sessionId: parsed.sessionId, eventId };
  } catch {
    return null;
  }
}

function sanitizeProviderDiscovery(provider: DiscoveredProvider, compatEvidence: Array<{
  id: string;
  provider: string;
  decision: string;
  passed: boolean;
  model?: string;
  probeId: string;
  targetLabel: string;
  sessionId?: string;
  taskRunId?: string;
  runSpecId?: string;
  traceId?: string;
  requestId?: string;
  nodeId?: string;
  totalTokens: number;
  summary: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}>): Record<string, unknown> {
  const { apiKey, ...rest } = provider;
  const readiness = describeProviderReadiness(provider);
  const evidence = compatEvidence.filter(item => item.provider === provider.name && item.passed);
  const verified = evidence.some(item => item.decision === 'verified_advisory' || item.decision === 'required');
  const promotionState = verified ? 'verified_advisory' : readiness.promotionState;
  return {
    ...rest,
    hasApiKey: typeof apiKey === 'string' && apiKey.length > 0,
    promotionState,
    compatibilityEvidence: evidence.map(sanitizeProviderCompatEvidence),
    readiness: {
      ...readiness,
      promotionState,
    },
  };
}

function sanitizeProviderCompatEvidence(item: {
  id: string;
  provider: string;
  model?: string;
  probeId: string;
  targetLabel: string;
  decision: string;
  passed: boolean;
  sessionId?: string;
  taskRunId?: string;
  runSpecId?: string;
  traceId?: string;
  requestId?: string;
  nodeId?: string;
  totalTokens: number;
  summary: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}): Record<string, unknown> {
  return {
    id: item.id,
    provider: item.provider,
    model: item.model ?? null,
    probeId: item.probeId,
    targetLabel: item.targetLabel,
    decision: item.decision,
    passed: item.passed,
    sessionId: item.sessionId ?? null,
    taskRunId: item.taskRunId ?? null,
    runSpecId: item.runSpecId ?? null,
    traceId: item.traceId ?? null,
    requestId: item.requestId ?? null,
    nodeId: item.nodeId ?? null,
    totalTokens: item.totalTokens,
    summary: sanitizeProviderCompatSummary(item.summary),
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  };
}

function sanitizeProviderCompatSummary(summary: Record<string, unknown>): Record<string, unknown> {
  return {
    completed: summary.completed === true,
    cancelled: summary.cancelled === true,
    reasoningObserved: summary.reasoningObserved === true,
    toolCalls: normalizeProviderSummaryStringArray(summary.toolCalls, 12),
    toolResultCount: normalizeNonNegativeNumber(summary.toolResultCount),
    failedToolResultCount: normalizeNonNegativeNumber(summary.failedToolResultCount),
    deniedToolCount: normalizeNonNegativeNumber(summary.deniedToolCount),
    failures: normalizeProviderSummaryStringArray(summary.failures, 8).map(failure => truncateForHttp(failure, 240)),
  };
}

function normalizeProviderSummaryStringArray(value: unknown, max: number): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter(item => typeof item === 'string' && item.trim())
    .slice(0, max)
    .map(item => item.trim());
}

function normalizeNonNegativeNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

function truncateForHttp(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}...`;
}

function sanitizeErrorMessage(message: string): string {
  return message.replace(/sk-[A-Za-z0-9_-]{8,}/g, 'sk-REDACTED');
}

function readProviderSource(provider: unknown): string | null {
  if (!provider || typeof provider !== 'object') return null;
  const record = provider as Record<string, unknown>;
  const source = record.source ?? record._source;
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
  const core = new Set(['deepseek', 'deepseek-anthropic', 'minimax', 'openai', 'codex', 'packycode']);
  const configured = Object.entries(config.providers)
    .filter(([name, provider]) => core.has(name) && provider.enabled)
    .map(([name]) => name);
  if (configured.length > 0) return configured;
  return [config.agent.defaultProvider];
}
