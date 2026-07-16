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
import { getSymbolCacheMetrics } from '../../chat-cbm-symbol-cache.js';

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
}

interface ProviderHealth {
  provider: string;
  totalCalls: number;
  errorCalls: number;
  errorRate: number;
  avgDurationMs: number;
  lastCallAt: string | null;
}

function isValidTraceId(value: string): boolean {
  return /^[a-zA-Z0-9_-]{4,200}$/.test(value);
}

export function registerDiagnosticsRoutes(app: FastifyInstance): void {
  app.get('/diagnostics/outbox', async () => ({
    outbox: await readExecutionOutboxHealth(),
  }));

  app.get('/diagnostics/cbm-cache', async () => ({
    cache: getSymbolCacheMetrics(),
  }));

  // ── Trace detail ────────────────────────────────────────
  app.get('/diagnostics/:traceId', async (req, reply) => {
    const traceId = (req.params as Record<string, string>).traceId;
    if (!traceId || !isValidTraceId(traceId)) {
      return reply.status(400).send({ error: 'Invalid traceId' });
    }

    await ensureSessionEventStore();
    await ensureProviderCallTelemetryStore();
    const db = getDb();

    // Session events for this trace
    const events = await db.query<DbRow>(
      `SELECT * FROM session_events WHERE trace_id = $1 ORDER BY id ASC LIMIT 1000`,
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
    await ensureSessionEventStore();
    const db = getDb();

    const rows = await db.query<TraceSummary>(
      `SELECT trace_id as "traceId",
              MIN(request_id) as "requestId",
              MIN(session_id) as "sessionId",
              MIN(created_at) as "startedAt",
              MAX(created_at) as "lastEventAt",
              COUNT(*)::int as "eventCount",
              COUNT(*) FILTER (WHERE type IN ('session.error','task.failed','tool.result'))
                ::int as "errorCount"
       FROM session_events
       WHERE trace_id IS NOT NULL AND created_at > NOW() - INTERVAL '24 hours'
       GROUP BY trace_id
       ORDER BY MAX(created_at) DESC
       LIMIT 100`,
    );

    return { traces: rows.rows };
  });

  // ── Provider health ─────────────────────────────────────
  app.get('/diagnostics/provider-health', async (_req, reply) => {
    await ensureProviderCallTelemetryStore();
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
      repairCounters: getRepairCounters(),
      symbolCache: getSymbolCacheMetrics(),
    };
  });
}
