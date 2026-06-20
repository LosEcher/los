/**
 * @los/agent/runtime-adapter/otel-bridge — OTel span ingest bridge.
 *
 * Accepts OTLP/HTTP spans from an OTel Collector (or directly from an
 * agent CLI with OTLP export enabled), maps them to los session_events,
 * and emits them onto the in-process eventBus for real-time consumers
 * (SSE, WebSocket, IM bots, etc.).
 *
 * Claude Code emits OTel natively when CLAUDE_CODE_ENABLE_TELEMETRY=1.
 * Codex and other CLIs can route their OTel output here too.
 *
 * Architecture:
 *   Claude Code --(OTLP/HTTP)--> OTel Collector --(forward)--> this bridge
 *   or directly: Claude Code --(OTLP/HTTP)--> this bridge (port 4318)
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { appendSessionEvent, type SessionEventWrite } from '../session-events.js';
import { eventBus } from '../event-bus.js';
import { getLogger } from '@los/infra/logger';
import {
  claudeSpanToEventType,
  type RuntimeKind,
} from './types.js';

const log = getLogger('otel-bridge');

// ── Types ──────────────────────────────────────────────────────────

export interface OtelBridgeConfig {
  /** Port to listen on for OTLP/HTTP POSTs (default 4318) */
  port?: number;
  /** Host to bind (default 127.0.0.1) */
  host?: string;
  /** Default session context when spans lack los headers */
  defaultSessionId?: string;
  defaultTenantId?: string;
  defaultProjectId?: string;
  defaultUserId?: string;
  /** Source label written into session_events.source */
  source?: string;
}

interface OtelResource {
  attributes?: Array<{ key: string; value: { stringValue?: string; intValue?: number } }>;
}

interface OtelSpan {
  traceId?: string;
  spanId?: string;
  parentSpanId?: string;
  name?: string;
  kind?: number;
  startTimeUnixNano?: string;
  endTimeUnixNano?: string;
  attributes?: Array<{ key: string; value: unknown }>;
  status?: { code?: number; message?: string };
}

interface OtelScopeSpan {
  scope?: { name?: string; version?: string };
  spans?: OtelSpan[];
}

interface OtelResourceSpan {
  resource?: OtelResource;
  scopeSpans?: OtelScopeSpan[];
}

interface OtelExportRequest {
  resourceSpans?: OtelResourceSpan[];
}

// ── Payload parsing ────────────────────────────────────────────────

function parseOtelAttributeValue(val: unknown): string | number | boolean | null | undefined {
  if (val === null || val === undefined) return undefined;
  if (typeof val === 'string') return val;
  if (typeof val === 'number') return val;
  if (typeof val === 'boolean') return val;
  if (typeof val === 'object') {
    const v = val as Record<string, unknown>;
    if ('stringValue' in v) return v.stringValue as string;
    if ('intValue' in v) return v.intValue as number;
    if ('doubleValue' in v) return v.doubleValue as number;
    if ('boolValue' in v) return v.boolValue as boolean;
    if ('arrayValue' in v && Array.isArray((v.arrayValue as Record<string, unknown>).values)) {
      return JSON.stringify(((v.arrayValue as Record<string, unknown>).values as Array<unknown>).map(item => parseOtelAttributeValue(item)));
    }
  }
  return String(val);
}

function parseOtelAttributes(attributes?: Array<{ key: string; value: unknown }>): Record<string, unknown> {
  if (!attributes) return {};
  const out: Record<string, unknown> = {};
  for (const attr of attributes) {
    const val = parseOtelAttributeValue(attr.value);
    if (val !== undefined) out[attr.key] = val;
  }
  return out;
}

function nanoToIso(ns: string | undefined): string | undefined {
  if (!ns) return undefined;
  const ms = Number(BigInt(ns) / 1_000_000n);
  return new Date(ms).toISOString();
}

// ── Span → Event mapping ───────────────────────────────────────────

function spanToSessionEvent(
  span: OtelSpan,
  resourceAttrs: Record<string, unknown>,
  config: OtelBridgeConfig,
): SessionEventWrite | null {
  if (!span.name) return null;

  const attrs = parseOtelAttributes(span.attributes);
  const resAttrs = resourceAttrs;
  const eventType = claudeSpanToEventType(span.name);

  // Derive session/tenant context from OTel resource attributes or span attributes.
  // Claude Code emits 'session.id' and other metadata as resource attributes.
  const sessionId = (attrs['session.id'] as string) ??
    (resAttrs['session.id'] as string) ??
    config.defaultSessionId ??
    `otel-${randomUUID()}`;

  const tenantId = (attrs['los.tenant_id'] as string) ??
    (resAttrs['los.tenant_id'] as string) ??
    config.defaultTenantId;

  const projectId = (attrs['los.project_id'] as string) ??
    (resAttrs['los.project_id'] as string) ??
    config.defaultProjectId;

  const userId = (attrs['los.user_id'] as string) ??
    (resAttrs['los.user_id'] as string) ??
    config.defaultUserId;

  const traceId = span.traceId ?? undefined;

  // Build normalized payload
  const payload: Record<string, unknown> = {
    spanName: span.name,
    spanId: span.spanId,
    parentSpanId: span.parentSpanId ?? null,
    spanKind: span.kind ?? null,
    startTime: nanoToIso(span.startTimeUnixNano) ?? null,
    endTime: nanoToIso(span.endTimeUnixNano) ?? null,
    ...attrs,
  };

  // Extract usage from model.response spans
  let usage: SessionEventWrite['usage'];
  if (attrs['llm.usage.prompt_tokens'] !== undefined || attrs['llm.usage.completion_tokens'] !== undefined) {
    usage = {
      promptTokens: Number(attrs['llm.usage.prompt_tokens'] ?? attrs['prompt_tokens'] ?? 0),
      completionTokens: Number(attrs['llm.usage.completion_tokens'] ?? attrs['completion_tokens'] ?? 0),
      cacheHitTokens: Number(attrs['llm.usage.cache_hit_tokens'] ?? attrs['cache_hit_tokens'] ?? 0),
      cacheMissTokens: Number(attrs['llm.usage.cache_miss_tokens'] ?? attrs['cache_miss_tokens'] ?? 0),
      totalTokens: Number(attrs['llm.usage.total_tokens'] ?? attrs['total_tokens'] ?? 0),
    };
  }

  // Extract tool name from tool spans
  let toolName: string | undefined;
  if (eventType.startsWith('tool.')) {
    toolName = (attrs['tool_name'] as string) ??
      (attrs['tool.name'] as string) ??
      (attrs['name'] as string);
  }

  // Extract model name
  const model = (attrs['model'] as string) ??
    (attrs['llm.model'] as string) ??
    (resAttrs['model'] as string);

  // Determine turn from attribute or default to 1
  const turn = typeof attrs['turn'] === 'number' ? attrs['turn'] as number :
    typeof attrs['loop_count'] === 'number' ? attrs['loop_count'] as number : 0;

  return {
    sessionId,
    tenantId,
    projectId,
    userId,
    traceId,
    turn,
    type: eventType,
    source: config.source ?? 'otel-bridge',
    model,
    toolName,
    usage,
    payload,
  };
}

// ── HTTP server ─────────────────────────────────────────────────────

let server: ReturnType<typeof createServer> | null = null;

export async function startOtelBridge(config: OtelBridgeConfig = {}): Promise<{ port: number; stop: () => Promise<void> }> {
  const port = config.port ?? 4318;
  const host = config.host ?? '127.0.0.1';

  server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', `http://${host}:${port}`);

    // Health check (GET)
    if (req.method === 'GET' && url.pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', service: 'los-otel-bridge', uptime: process.uptime() }));
      return;
    }

    if (req.method !== 'POST') {
      res.writeHead(405, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Method not allowed — OTLP uses POST' }));
      return;
    }

    // OTLP/HTTP paths:
    //   /v1/traces  — span export
    //   /v1/metrics — metric export (not yet handled; log and ack)
    //   /v1/logs    — log export (not yet handled; log and ack)
    const isTraces = url.pathname === '/v1/traces';
    const isMetrics = url.pathname === '/v1/metrics';
    const isLogs = url.pathname === '/v1/logs';

    if (!isTraces && !isMetrics && !isLogs) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
      return;
    }

    // Read body
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
    }
    const body = Buffer.concat(chunks).toString('utf-8');

    let parsed: OtelExportRequest;
    try {
      parsed = JSON.parse(body);
    } catch {
      log.warn('OTel bridge received unparseable body');
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid JSON' }));
      return;
    }

    let eventCount = 0;
    let errorCount = 0;

    if (isTraces && parsed.resourceSpans) {
      // ── Trace spans → session_events ────────────────────
      for (const rs of parsed.resourceSpans) {
        const resourceAttrs = parseOtelAttributes(rs.resource?.attributes);

        for (const ss of rs.scopeSpans ?? []) {
          for (const span of ss.spans ?? []) {
            try {
              const event = spanToSessionEvent(span, resourceAttrs, config);
              if (!event) continue;

              await appendSessionEvent(event).catch((err) => {
                log.warn(`Failed to write otel span as session event: ${(err as Error).message}`);
                errorCount++;
                return null;
              });

              // Emit on in-process event bus for real-time consumers
              eventBus.emit('session:event', {
                sessionId: event.sessionId,
                eventId: 0, // The actual ID is assigned by appendSessionEvent
                type: event.type,
                channel: 'otel',
              });

              eventCount++;
            } catch (err) {
              errorCount++;
              log.warn(`Span mapping failed: ${(err as Error).message}`);
            }
          }
        }
      }
    } else if (isMetrics || isLogs) {
      // Metrics and logs: ack but don't process yet.
      // Future: map metrics → provider_call_telemetry, logs → session_events.
      log.debug(`OTel bridge received ${isMetrics ? 'metrics' : 'logs'} export (not yet processed)`);
    }

    // OTLP partial success response
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      partialSuccess: errorCount > 0 ? { rejectedSpans: errorCount } : undefined,
    }));
  });

  await new Promise<void>((resolve) => server!.listen(port, host, resolve));
  log.info(`OTel bridge listening on http://${host}:${port} (OTLP/HTTP)`);

  return {
    port,
    stop: async () => {
      if (!server) return;
      await new Promise<void>((resolve, reject) => {
        server!.close((err) => err ? reject(err) : resolve());
      });
      server = null;
      log.info('OTel bridge stopped');
    },
  };
}

export function isOtelBridgeRunning(): boolean {
  return server !== null && server.listening;
}
