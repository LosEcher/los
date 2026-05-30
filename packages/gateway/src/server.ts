/**
 * @los/gateway — Fastify HTTP server with SSE streaming.
 *
 * Inspired by Hermes Web UI (BFF pattern) and Open WebUI.
 * Routes: POST /chat (SSE stream), GET/POST /memory, GET /health.
 */

import Fastify from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import { readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getConfig, loadConfig, printConfigDiagnostics } from '@los/infra/config';
import { initDb } from '@los/infra/db';
import { printOnboardingReport, discoverAll } from '@los/infra/discovery';
import { getLogger } from '@los/infra/logger';
import { cancelScheduledTask, runScheduledAgentTask } from '@los/agent/scheduler';
import { ensureSessionStore, saveSession, loadSession, listSessions } from '@los/agent/session';
import {
  ensureTaskRunStore,
  loadTaskRun,
  listTaskRuns,
  updateTaskRun,
} from '@los/agent/task-runs';
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

type ToolMode = 'all' | 'project-write' | 'read-only';

interface ChatRequestBody {
  prompt: string;
  sessionId?: string;
  systemPrompt?: string;
  provider?: string;
  workspaceRoot?: string;
  toolMode?: ToolMode;
  allowedTools?: string[];
  maxLoops?: number;
  traceId?: string;
  dedupeKey?: string;
  timeoutMs?: number;
  toolRetry?: {
    maxAttempts?: number;
    baseDelayMs?: number;
    maxDelayMs?: number;
  };
}

export async function createServer() {
  const config = getConfig();
  const app = Fastify({ logger: false });

  await app.register(cors, { origin: true });

  // ── Static HTML ──────────────────────────────────────

  await app.register(fastifyStatic, {
    root: join(__dirname),
    prefix: '/',
  });

  // Index page
  app.get('/', async (_req, reply) => {
    return reply.type('text/html').send(
      readFileSync(join(__dirname, 'index.html'), 'utf-8')
    );
  });

  // ── Onboarding ──────────────────────────────────────

  app.get('/onboarding', async () => {
    return await discoverAll();
  });

  // ── Health ───────────────────────────────────────────

  app.get('/health', async () => {
    return { status: 'ok', uptime: process.uptime() };
  });

  // ── Chat (SSE streaming) ─────────────────────────────

  app.post('/chat', async (req, reply) => {
    const body = req.body as ChatRequestBody;
    const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
    const sessionId = normalizeOptionalString(body.sessionId);
    const systemPrompt = normalizeOptionalString(body.systemPrompt);
    const provider = normalizeOptionalString(body.provider);
    const workspaceRoot = normalizeWorkspaceRoot(body.workspaceRoot);
    const toolMode = normalizeToolMode(body.toolMode);
    const allowedTools = normalizeAllowedTools(body.allowedTools);
    const maxLoops = normalizePositiveInteger(body.maxLoops);
    const traceId = normalizeOptionalString(body.traceId);
    const dedupeKey = normalizeOptionalString(body.dedupeKey);
    const timeoutMs = normalizePositiveInteger(body.timeoutMs);
    const toolRetry = normalizeToolRetry(body.toolRetry);

    if (!prompt) {
      return reply.status(400).send({ error: 'prompt is required' });
    }

    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    const send = (event: string, data: unknown) => {
      reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    const sid = sessionId ?? `session-${Date.now()}`;
    let activeTaskRunId: string | undefined;
    let sentSession = false;

    try {
      const scheduled = await runScheduledAgentTask({
        prompt,
        sessionId: sid,
        provider,
        systemPrompt,
        workspaceRoot,
        toolMode,
        allowedTools,
        maxLoops,
        traceId,
        dedupeKey,
        timeoutMs,
        toolRetry,
        metadata: {
          maxLoops: maxLoops ?? config.agent.maxLoops,
          allowedTools,
          timeoutMs,
          toolRetry,
        },
        onTaskEvent: (event) => {
          activeTaskRunId = event.taskRun.id;
          if (!sentSession && event.type !== 'task.deduplicated') {
            sentSession = true;
            send('session', {
              sessionId: event.taskRun.sessionId,
              taskRunId: event.taskRun.id,
              traceId: event.taskRun.traceId,
              dedupeKey: event.taskRun.dedupeKey ?? null,
            });
          }
          send('task', {
            type: event.type,
            taskRunId: event.taskRun.id,
            sessionId: event.taskRun.sessionId,
            traceId: event.taskRun.traceId,
            dedupeKey: event.taskRun.dedupeKey ?? null,
            status: event.taskRun.status,
          });
        },
        onTurn: (turn) => {
          send('turn', {
            loopCount: turn.loopCount,
            text: turn.text.slice(0, 200),
            toolCallCount: turn.toolCalls.length,
            toolNames: turn.toolCalls.map(tc => tc.function.name),
            reasoning: turn.reasoningContent?.slice(0, 200),
          });
        },
        onToolCall: (tool, args) => {
          send('tool_call', { tool, args: JSON.stringify(args).slice(0, 200) });
        },
      });

      if (scheduled.status === 'deduplicated') {
        send('deduplicated', {
          sessionId: scheduled.sessionId,
          taskRunId: scheduled.taskRun.id,
          traceId: scheduled.taskRun.traceId,
          dedupeKey: scheduled.taskRun.dedupeKey ?? null,
          status: scheduled.taskRun.status,
        });
        send('done', {
          deduplicated: true,
          sessionId: scheduled.sessionId,
          taskRunId: scheduled.taskRun.id,
        });
        reply.raw.end();
        return;
      }

      if (scheduled.status === 'cancelled') {
        send('cancelled', {
          sessionId: scheduled.sessionId,
          taskRunId: scheduled.taskRun.id,
          traceId: scheduled.taskRun.traceId,
          dedupeKey: scheduled.taskRun.dedupeKey ?? null,
          reason: scheduled.reason,
        });
        send('done', {
          cancelled: true,
          sessionId: scheduled.sessionId,
          taskRunId: scheduled.taskRun.id,
          reason: scheduled.reason,
        });
        reply.raw.end();
        return;
      }

      const result = scheduled.result;
      const taskRunId = scheduled.taskRun.id;

      // Save session
      await ensureSessionStore();
      await saveSession({
        id: sid,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        messages: result.messages,
        turns: result.turns,
        metadata: {
          provider: provider ?? config.agent.defaultProvider,
          workspaceRoot,
          toolMode,
          allowedTools,
          maxLoops: maxLoops ?? config.agent.maxLoops,
          timeoutMs,
          toolRetry,
          taskRunId,
          traceId: scheduled.taskRun.traceId,
          dedupeKey: scheduled.taskRun.dedupeKey ?? null,
        },
      });

      // Save observation to memory
      await ensureMemoryStore();
      await addObservation({
        title: `Chat session ${sid.slice(0, 12)}`,
        summary: `Prompt: ${prompt.slice(0, 200)} — ${result.text.slice(0, 200)}`,
        kind: 'note',
        tags: ['chat', 'session'],
        source: 'agent',
        sessionId: sid,
      });

      send('done', {
        text: result.text,
        turns: result.loopCount,
        tokens: result.totalTokens,
        sessionId: sid,
        taskRunId,
      });
    } catch (err: any) {
      await ensureSessionEventStore().catch(() => undefined);
      await appendSessionEvent({
        sessionId: sid,
        type: 'session.error',
        turn: 0,
        payload: {
          message: err?.message ?? String(err),
          taskRunId: activeTaskRunId ?? null,
        },
      }).catch(() => undefined);
      send('error', { message: err?.message ?? String(err) });
    }

    reply.raw.end();
  });

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
    await ensureMemoryStore();
    const obs = await addObservation({ title, summary, kind, tags, content, source });
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
      return {
        ok: true,
        live: true,
        taskRunId: id,
        status: taskRun.status,
        reason,
      };
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
  startServer();
}

function normalizeWorkspaceRoot(value: unknown): string {
  if (typeof value !== 'string') return DEFAULT_WORKSPACE_ROOT;
  const trimmed = value.trim();
  return trimmed ? resolve(trimmed) : DEFAULT_WORKSPACE_ROOT;
}

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function normalizeToolMode(value: unknown): ToolMode {
  if (value === 'read-only' || value === 'project-write' || value === 'all') return value;
  return 'project-write';
}

function normalizeAllowedTools(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const tools = value
    .map(item => typeof item === 'string' ? item.trim() : '')
    .filter(Boolean);
  return tools.length > 0 ? [...new Set(tools)] : undefined;
}

function normalizePositiveInteger(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  const int = Math.floor(value);
  return int > 0 ? int : undefined;
}

function normalizeToolRetry(value: unknown): ChatRequestBody['toolRetry'] | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  return {
    maxAttempts: normalizePositiveInteger(raw.maxAttempts),
    baseDelayMs: normalizeNonNegativeInteger(raw.baseDelayMs),
    maxDelayMs: normalizeNonNegativeInteger(raw.maxDelayMs),
  };
}

function normalizeNonNegativeInteger(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  const int = Math.floor(value);
  return int >= 0 ? int : undefined;
}
