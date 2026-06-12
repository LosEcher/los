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
  errorCode?: string;
  errorMessage?: string;
  rateLimitResetMs?: number;
  usage?: { promptTokens: number; completionTokens: number };
  createdAt?: string;
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
  await db.query(
    `INSERT INTO provider_call_telemetry
       (trace_id, session_id, provider, model, endpoint, method, stream,
        request_payload_size, status, duration_ms,
        error_code, error_message, rate_limit_reset_ms, usage_json)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
    [
      tel.traceId,
      tel.sessionId ?? null,
      tel.provider,
      tel.model,
      tel.endpoint,
      tel.method,
      tel.stream,
      tel.requestPayloadSize,
      tel.status,
      tel.durationMs,
      tel.errorCode ?? null,
      tel.errorMessage ?? null,
      tel.rateLimitResetMs ?? null,
      JSON.stringify(tel.usage ?? {}),
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
