/**
 * Diagnostics routes — universal request inspection and provider health.
 *
 * GET /diagnostics/:traceId       — full request trace across all tables
 * GET /diagnostics                — recent trace list with error counts
 * GET /diagnostics/provider-health — provider success rate / avg latency
 */

import type { FastifyInstance } from 'fastify';
import { getDb } from '@los/infra/db';
import { ensureSessionEventStore } from '@los/agent/session-events';
import { ensureProviderCallTelemetryStore } from '@los/agent/providers/telemetry';
import { getRepairCounters } from '@los/agent/providers/repair-telemetry';
import { readExecutionOutboxHealth } from '@los/agent/execution-outbox';
import {
  MAX_PAYLOAD_DEPTH,
  MAX_PAYLOAD_JSON_BYTES,
  MAX_PAYLOAD_STRING_CHARS,
  payloadRedactorCount,
} from '@los/agent/event-redaction';
import { getSymbolCacheMetrics } from '../../chat-cbm-symbol-cache.js';

export type DiagnosticsRouteDependencies = {
  ensureProviderCallTelemetryStore: typeof ensureProviderCallTelemetryStore;
  ensureSessionEventStore: typeof ensureSessionEventStore;
  readExecutionOutboxHealth: typeof readExecutionOutboxHealth;
  getRepairCounters: typeof getRepairCounters;
};

const defaultDependencies: DiagnosticsRouteDependencies = {
  ensureProviderCallTelemetryStore,
  ensureSessionEventStore,
  readExecutionOutboxHealth,
  getRepairCounters,
};

// DB columns use snake_case; use Record<string, any> for raw query results.
type DbRow = Record<string, any>;

interface TraceSummary {
  traceId: string;
  requestId: string | null;
  sessionId: string | null;
  startedAt: string | null;
  lastEventAt: string | null;
  eventCount: number;
  errorCount: number;
  model: string | null;
}

interface ProviderHealth {
  provider: string;
  totalCalls: number;
  errorCalls: number;
  errorRate: number;
  avgDurationMs: number;
  lastCallAt: string | null;
}

/** span 树节点：session_events.parent_event_id 链的可视化投影。 */
interface SpanNode {
  eventId: number;
  type: string;
  parentEventId: number | null;
  sessionId: string;
  turn: number;
  model: string | null;
  toolName: string | null;
  createdAt: string;
  /** parent 不在当前 trace 事件集内（跨 session 引用或链头缺失）。 */
  orphan: boolean;
  children: SpanNode[];
}

/** 按 parent_event_id 构建 span 树；parent 缺失（跨 session/越界）的节点作为根并标记 orphan。 */
function buildSpanTree(rows: DbRow[]): SpanNode[] {
  const nodes = new Map<number, SpanNode>();
  for (const e of rows) {
    nodes.set(e.id, {
      eventId: e.id,
      type: e.type,
      parentEventId: e.parent_event_id ?? null,
      sessionId: e.session_id,
      turn: e.turn ?? 0,
      model: e.model ?? null,
      toolName: e.tool_name ?? null,
      createdAt: e.created_at,
      orphan: false,
      children: [],
    });
  }
  const roots: SpanNode[] = [];
  for (const node of nodes.values()) {
    const parent = node.parentEventId != null ? nodes.get(node.parentEventId) : undefined;
    if (parent && parent !== node) {
      parent.children.push(node);
    } else {
      if (node.parentEventId != null) node.orphan = true;
      roots.push(node);
    }
  }
  const byTime = (a: SpanNode, b: SpanNode) => String(a.createdAt).localeCompare(String(b.createdAt));
  const sortRec = (list: SpanNode[]) => {
    list.sort(byTime);
    for (const n of list) sortRec(n.children);
  };
  sortRec(roots);
  return roots;
}

function isValidTraceId(value: string): boolean {
  return /^[a-zA-Z0-9_-]{4,200}$/.test(value);
}

export function registerDiagnosticsRoutes(
  app: FastifyInstance,
  deps: DiagnosticsRouteDependencies = defaultDependencies,
): void {
  app.get('/diagnostics/outbox', async () => ({
    outbox: await deps.readExecutionOutboxHealth(),
  }));

  app.get('/diagnostics/cbm-cache', async () => ({
    cache: getSymbolCacheMetrics(),
  }));

  // ── Redaction waterfall policy ───────────────────────────
  app.get('/diagnostics/redaction', async () => ({
    pipeline: 'default + registered extensions',
    failClosed: true,
    limits: {
      maxStringChars: MAX_PAYLOAD_STRING_CHARS,
      maxDepth: MAX_PAYLOAD_DEPTH,
      maxJsonBytes: MAX_PAYLOAD_JSON_BYTES,
    },
    activeRedactors: payloadRedactorCount(),
  }));

  // ── Trace detail ────────────────────────────────────────
  app.get('/diagnostics/:traceId', async (req, reply) => {
    const traceId = (req.params as Record<string, string>).traceId;
    if (!traceId || !isValidTraceId(traceId)) {
      return reply.status(400).send({ error: 'Invalid traceId' });
    }

    await deps.ensureSessionEventStore();
    await deps.ensureProviderCallTelemetryStore();
    const db = getDb();

    // Session events for this trace
    const events = await db.query<DbRow>(
      `SELECT * FROM session_events WHERE trace_id = $1 ORDER BY id ASC LIMIT 1000`,
      [traceId],
    );

    // Task runs for this trace (cross-entity aggregation)
    const taskRuns = await db.query<DbRow>(
      `SELECT id, run_spec_id, session_id, status, provider, model, attempt, started_at, completed_at
       FROM task_runs WHERE trace_id = $1 ORDER BY started_at ASC`,
      [traceId],
    );

    // Todos attributed to this trace
    const todos = await db.query<DbRow>(
      `SELECT id, title, status, priority, kind, created_at
       FROM todos WHERE trace_id = $1 ORDER BY created_at ASC LIMIT 100`,
      [traceId],
    );

    // Provider calls for this trace
    const providerCalls = await db.query<DbRow>(
      `SELECT * FROM provider_call_telemetry WHERE trace_id = $1 ORDER BY created_at ASC`,
      [traceId],
    );

    // Try to find the run spec
    const runSpecs = await db.query<DbRow>(
      `SELECT * FROM run_specs WHERE trace_id = $1 LIMIT 1`,
      [traceId],
    );
    const runSpec = runSpecs.rows[0] ?? null;

    // Try to find the session summary
    let session: Record<string, unknown> | null = null;
    const sessionId = runSpec?.session_id as string | undefined
      ?? events.rows[0]?.session_id;
    if (sessionId) {
      const sessionRows = await db.query<DbRow>(
        `SELECT id, COUNT(*)::int as event_count,
                MIN(created_at) as first_event_at, MAX(created_at) as last_event_at
         FROM session_events WHERE session_id = $1
         GROUP BY id`,
        [sessionId],
      );
      session = sessionRows.rows[0] ?? null;
    }

    // Extract errors
    const errorTypes = new Set([
      'session.error', 'task.failed', 'tool.result',
      'run.recovery_required', 'run.blocked', 'run.operator_attention_required',
    ]);
    const errors = events.rows
      .filter(e => e.type === 'session.error' || e.type?.includes('error') || e.type?.includes('failed'))
      .map(e => ({
        timestamp: e.created_at,
        type: e.type,
        message: (e.payload_json as Record<string, unknown>)?.message ?? null,
        toolName: e.tool_name,
        turn: e.turn,
      }));

    // Build merged timeline
    const timeline: Array<Record<string, unknown>> = [];
    for (const e of events.rows) {
      timeline.push({
        timestamp: e.created_at,
        source: 'event',
        type: e.type,
        summary: e.type === 'model.response'
          ? `model ${e.model} · ${((e.payload_json as Record<string, unknown>)?.toolCallCount ?? 0)} tool calls`
          : e.type === 'tool.result'
            ? `${e.tool_name} · ${(e.payload_json as Record<string, unknown>)?.ok ? 'ok' : 'error'}`
            : undefined,
      });
    }
    for (const pc of providerCalls.rows) {
      timeline.push({
        timestamp: pc.created_at,
        source: 'provider',
        type: 'provider.call',
        summary: `${pc.provider}/${pc.model} ${pc.endpoint} → ${pc.status} ${pc.duration_ms}ms`,
      });
    }
    timeline.sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp)));

    return {
      traceId,
      requestId: runSpec?.request_id ?? events.rows[0]?.request_id ?? null,
      runSpec: runSpec ? {
        id: runSpec.id,
        sessionId: runSpec.session_id,
        status: runSpec.status,
        prompt: typeof runSpec.prompt === 'string' ? (runSpec.prompt as string).slice(0, 200) : null,
        provider: runSpec.provider,
        model: runSpec.model,
        createdAt: runSpec.created_at,
      } : null,
      session,
      eventCount: events.rows.length,
      providerCallCount: providerCalls.rows.length,
      errors,
      timeline: timeline.slice(0, 200), // cap at 200 entries
      // P0-2 additions (backward-compatible): cross-entity aggregation + span tree.
      taskRuns: taskRuns.rows.map(tr => ({
        id: tr.id,
        runSpecId: tr.run_spec_id ?? null,
        sessionId: tr.session_id ?? null,
        status: tr.status,
        provider: tr.provider ?? null,
        model: tr.model ?? null,
        startedAt: tr.started_at ?? null,
        completedAt: tr.completed_at ?? null,
        attempt: tr.attempt ?? 1,
      })),
      todos: todos.rows.map(t => ({
        id: t.id,
        title: t.title,
        status: t.status,
        priority: t.priority ?? null,
        kind: t.kind ?? null,
        createdAt: t.created_at,
      })),
      spanTree: buildSpanTree(events.rows),
      providerCalls: providerCalls.rows.map(pc => ({
        provider: pc.provider,
        model: pc.model,
        endpoint: pc.endpoint,
        status: pc.status,
        durationMs: pc.duration_ms,
        errorCode: pc.error_code,
        errorMessage: pc.error_message,
        createdAt: pc.created_at,
      })),
    };
  });

  // ── Recent traces ───────────────────────────────────────
  app.get('/diagnostics', async (_req, reply) => {
    await deps.ensureSessionEventStore();
    const db = getDb();

    const rows = await db.query<TraceSummary>(
      `SELECT s.trace_id as "traceId",
              MIN(s.request_id) as "requestId",
              MIN(s.session_id) as "sessionId",
              MIN(s.created_at) as "startedAt",
              MAX(s.created_at) as "lastEventAt",
              COUNT(*)::int as "eventCount",
              COUNT(*) FILTER (WHERE s.type IN ('session.error','task.failed','tool.result'))
                ::int as "errorCount",
              (SELECT e2.model FROM session_events e2
                WHERE e2.trace_id = s.trace_id AND e2.model IS NOT NULL
                ORDER BY e2.id DESC LIMIT 1) as "model"
       FROM session_events s
       WHERE s.trace_id IS NOT NULL AND s.created_at > NOW() - INTERVAL '24 hours'
       GROUP BY s.trace_id
       ORDER BY MAX(s.created_at) DESC
       LIMIT 100`,
    );

    return { traces: rows.rows };
  });

  // ── Provider health ─────────────────────────────────────
  app.get('/diagnostics/provider-health', async (_req, reply) => {
    await deps.ensureProviderCallTelemetryStore();
    const db = getDb();

    const rows = await db.query<ProviderHealth>(
      `SELECT provider,
              COUNT(*)::int as "totalCalls",
              COUNT(*) FILTER (WHERE status >= 400 OR status = 0)::int as "errorCalls",
              ROUND(COUNT(*) FILTER (WHERE status >= 400 OR status = 0)::numeric
                / NULLIF(COUNT(*), 0) * 100, 1) as "errorRate",
              ROUND(AVG(duration_ms))::int as "avgDurationMs",
              MAX(created_at) as "lastCallAt"
       FROM provider_call_telemetry
       WHERE created_at > NOW() - INTERVAL '15 minutes'
       GROUP BY provider
       ORDER BY "totalCalls" DESC`,
    );

    return {
      providers: rows.rows,
      windowMs: 15 * 60 * 1000,
      repairCounters: deps.getRepairCounters(),
      symbolCache: getSymbolCacheMetrics(),
    };
  });
}
