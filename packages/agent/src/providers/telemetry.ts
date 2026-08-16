/**
 * Provider call telemetry — always-on recording of every external provider API call.
 *
 * Each fetch() to a model provider is recorded in the provider_call_telemetry table
 * with traceId, timing, status, and structured error info. This feeds the
 * GET /diagnostics/:traceId and GET /diagnostics/provider-health endpoints.
 *
 * Zero overhead in the hot path: a single INSERT with no joins.
 */

import { getDb } from '@los/infra/db';
import { redactPayload } from '../event-redaction.js';

export interface ProviderCallTelemetry {
  id?: number;
  traceId: string;
  sessionId?: string;
  provider: string;
  model: string;
  endpoint: string;
  method: 'POST' | 'GET';
  stream: boolean;
  requestPayloadSize: number;
  status: number;
  durationMs: number;
  /** Time from request start to HTTP headers (P0-2, 2026-08-06). */
  headersDurationMs?: number;
  /** Time from headers to body fully read/parsed (P0-2). */
  bodyDurationMs?: number;
  errorCode?: string;
  errorMessage?: string;
  rateLimitResetMs?: number;
   /**
    * Request-side configuration snapshot (reasoning effort, sampling scalars).
    * Mirrors DSH's LlmCallConfig-in-header approach: without the requested
    * effort, historical data cannot attribute cost/latency/quality to the
    * reasoning tier that was actually used.
    */
   requestMeta?: {
    reasoningEffort?: 'low' | 'medium' | 'high' | 'max' | 'xhigh' | 'none';
    thinking?: 'enabled' | 'disabled';
    maxTokens?: number;
    temperature?: number;
    /** Usage feature attribution (roadmap R6). */
    feature?: string;
  };
  /** Token usage from the provider response. Prefer writing this on success paths. */
  usage?: {
    promptTokens: number;
    completionTokens: number;
    cacheHitTokens?: number;
    cacheMissTokens?: number;
    totalTokens?: number;
  };
  createdAt?: string;
}

/** Normalize ProviderResponse-style usage for telemetry JSON persistence. */
export function telemetryUsageFromProvider(usage?: {
  promptTokens?: number;
  completionTokens?: number;
  cacheHitTokens?: number;
  cacheMissTokens?: number;
  totalTokens?: number;
} | null): ProviderCallTelemetry['usage'] | undefined {
  if (!usage) return undefined;
  const promptTokens = Number(usage.promptTokens ?? 0);
  const completionTokens = Number(usage.completionTokens ?? 0);
  if (!Number.isFinite(promptTokens) && !Number.isFinite(completionTokens)) return undefined;
  const cacheHitTokens = usage.cacheHitTokens;
  const cacheMissTokens = usage.cacheMissTokens;
  const totalTokens = usage.totalTokens;
  return {
    promptTokens: Number.isFinite(promptTokens) ? promptTokens : 0,
    completionTokens: Number.isFinite(completionTokens) ? completionTokens : 0,
    ...(cacheHitTokens !== undefined ? { cacheHitTokens: Number(cacheHitTokens) || 0 } : {}),
    ...(cacheMissTokens !== undefined ? { cacheMissTokens: Number(cacheMissTokens) || 0 } : {}),
    ...(totalTokens !== undefined ? { totalTokens: Number(totalTokens) || 0 } : {}),
  };
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS provider_call_telemetry (
  id BIGSERIAL PRIMARY KEY,
  trace_id TEXT NOT NULL,
  session_id TEXT,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  method TEXT NOT NULL DEFAULT 'POST',
  stream BOOLEAN NOT NULL DEFAULT false,
  request_payload_size INTEGER NOT NULL DEFAULT 0,
  status INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL,
  error_code TEXT,
  error_message TEXT,
  rate_limit_reset_ms INTEGER,
  usage_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE provider_call_telemetry ADD COLUMN IF NOT EXISTS headers_duration_ms INTEGER;
ALTER TABLE provider_call_telemetry ADD COLUMN IF NOT EXISTS body_duration_ms INTEGER;
ALTER TABLE provider_call_telemetry ADD COLUMN IF NOT EXISTS request_meta_json JSONB;
CREATE INDEX IF NOT EXISTS idx_pct_trace_id ON provider_call_telemetry(trace_id);
CREATE INDEX IF NOT EXISTS idx_pct_session_id ON provider_call_telemetry(session_id);
CREATE INDEX IF NOT EXISTS idx_pct_provider ON provider_call_telemetry(provider);
CREATE INDEX IF NOT EXISTS idx_pct_status ON provider_call_telemetry(status);
CREATE INDEX IF NOT EXISTS idx_pct_created ON provider_call_telemetry(created_at DESC);
`;

let _initialized = false;

export async function ensureProviderCallTelemetryStore(): Promise<void> {
  if (_initialized) return;
  const db = getDb();
  await db.exec(SCHEMA);
  _initialized = true;
}

export async function recordProviderCall(tel: ProviderCallTelemetry): Promise<void> {
  await ensureProviderCallTelemetryStore();
  const db = getDb();
  // 写路径脱敏瀑布：endpoint 可能含签名/密钥查询参数，errorMessage 可能回显
  // 响应体中的密钥形态。规范数据不重写，只作用于本写入副本（fail-closed）。
  const redacted = redactPayload(
    {
      endpoint: tel.endpoint ?? '',
      errorMessage: tel.errorMessage ?? null,
    },
    'telemetry.provider_call',
  );
  const endpoint = typeof redacted.endpoint === 'string' ? redacted.endpoint : '';
  const errorMessage =
    typeof redacted.errorMessage === 'string' ? redacted.errorMessage : tel.errorMessage ?? null;
  await db.query(
    `INSERT INTO provider_call_telemetry
       (trace_id, session_id, provider, model, endpoint, method, stream,
        request_payload_size, status, duration_ms,
        headers_duration_ms, body_duration_ms,
        error_code, error_message, rate_limit_reset_ms, usage_json, request_meta_json)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
    [
      tel.traceId,
      tel.sessionId ?? null,
      tel.provider,
      tel.model,
      endpoint,
      tel.method,
      tel.stream,
      tel.requestPayloadSize,
      tel.status,
      tel.durationMs,
      tel.headersDurationMs ?? null,
      tel.bodyDurationMs ?? null,
      tel.errorCode ?? null,
      errorMessage,
      tel.rateLimitResetMs ?? null,
      JSON.stringify(tel.usage ?? {}),
       tel.requestMeta
         ? JSON.stringify({
             reasoningEffort: tel.requestMeta.reasoningEffort ?? null,
             thinking: tel.requestMeta.thinking ?? null,
             maxTokens: tel.requestMeta.maxTokens ?? null,
             temperature: tel.requestMeta.temperature ?? null,
             feature: tel.requestMeta.feature ?? null,
           })
         : null,
    ],
  );
}

/**
 * High-level wrapper: execute a provider fetch and record telemetry.
 * Returns the Response on success, throws AgentError on failure.
 */
export async function tracedFetch(
  telBase: Omit<ProviderCallTelemetry, 'status' | 'durationMs' | 'requestPayloadSize'>,
  fn: () => Promise<{ res: Response; body: string }>,
): Promise<Response> {
  const startedAt = Date.now();
  try {
    const { res, body } = await fn();
    const durationMs = Date.now() - startedAt;

    // Fire-and-forget: don't block the response on telemetry insert
    recordProviderCall({
      ...telBase,
      status: res.status,
      durationMs,
      requestPayloadSize: body.length,
    }).catch(() => {});

    return res;
  } catch (err: any) {
    const durationMs = Date.now() - startedAt;
    recordProviderCall({
      ...telBase,
      status: 0, // 0 = network error (no HTTP response)
      durationMs,
      requestPayloadSize: 0,
      errorCode: 'PROVIDER_NETWORK',
      errorMessage: err?.message?.slice(0, 500) ?? 'Unknown fetch error',
    }).catch(() => {});

    throw err;
  }
}
