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
import { normalizeUsageFeature } from '../usage-feature.js';

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
             // R-LOS-01: 写路径归一化——未登记 purpose 归一为 'unspecified' 并告警，
             // 保证 byFeature 立方只出现已知 purpose（外部配置/历史调用不污染聚合）。
             feature:
               tel.requestMeta.feature !== undefined
                 ? normalizeUsageFeature(tel.requestMeta.feature)
                 : null,
           })
         : null,
    ],
  );
}

/**
 * 从 `provider_call_telemetry` 聚合某个 provider 近期的**真实调用结果**，供健康评分使用。
 *
 * ## 为什么需要它（2026-10-12 实测）
 *
 * `computeHealthScore(provider, probe, outcomes)` 的权重是
 * RTT 0.4 / **成功率 0.4** / 可用性 0.2；而 `outcomes` 缺失时公式走
 * "no outcome data → benefit of the doubt"，`successRate = 1.0`。
 * 于是「探针连得上、真实调用却 401/410」的 provider 会拿高分：实测
 * `nvidia-nim`（410 Gone）与 `opencode-zen`（401）在 `/providers/health` 里都是 healthy。
 *
 * 评分器**本来就设计**了 outcomes 入参，`provider-selection.ts:37` 也真的取了它，
 * 但**探针循环（`provider-probe.ts`）只传 probe** ⇒ 同一件事两套算法、输入不同。
 * 本函数让探针侧用上与选择侧**同一个窗口（24h）**的同一份数据。
 *
 * `status` 是 HTTP 状态码，`0` 表示传输层失败（`PROVIDER_NETWORK`）。
 * 窗口内按 `model` 分组、取调用量最大的那条（与 `ProviderRecentOutcome.model` 对齐）。
 * **窗口内无数据时返回 `undefined`** —— 让评分器继续走"对未测 provider 宽恕"的原语义，
 * 不给新 provider 凭空扣分。
 */
export async function getRecentProviderOutcomes(
  provider: string,
  windowHours = 24,
): Promise<{
  provider: string; model: string; totalTasks: number; succeeded: number; failed: number;
  avgDurationMs: number; avgTokens: number; lastOutcomeAt: string;
} | undefined> {
  await ensureProviderCallTelemetryStore();
  const rows = await getDb().query<{
    model: string; total: number; succeeded: number; avg_ms: number; avg_tokens: number; last_at: Date | string;
  }>(
    `SELECT model,
            count(*)::int AS total,
            count(*) FILTER (WHERE status >= 200 AND status < 300)::int AS succeeded,
            coalesce(avg(duration_ms), 0)::int AS avg_ms,
            coalesce(avg((usage_json->>'totalTokens')::numeric)
                     FILTER (WHERE usage_json->>'totalTokens' ~ '^[0-9]+$'), 0)::int AS avg_tokens,
            max(created_at) AS last_at
       FROM provider_call_telemetry
      WHERE provider = $1 AND created_at > now() - make_interval(hours => $2)
      GROUP BY model
      ORDER BY total DESC
      LIMIT 1`,
    [provider, windowHours],
  );
  const row = rows.rows[0];
  if (!row || row.total === 0) return undefined;
  return {
    provider,
    model: row.model,
    totalTasks: row.total,
    succeeded: row.succeeded,
    failed: row.total - row.succeeded,
    avgDurationMs: row.avg_ms,
    avgTokens: row.avg_tokens,
    lastOutcomeAt: (row.last_at instanceof Date ? row.last_at : new Date(row.last_at)).toISOString(),
  };
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
