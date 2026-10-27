/**
 * @los/agent/providers/provider-probe — Lightweight provider health check with RTT measurement.
 *
 * Design: fire-and-forget, non-blocking. Probe results are cached and
 * surface into health-aware routing (ADR 0043). A failed probe does NOT block
 * provider usage — it only affects preference ranking and fallback skips.
 *
 * Cadence (ADR 0043): 60s while scheduling is active, 300s when idle.
 * RTT is exponentially smoothed (α=0.3) so scores do not thrash.
 *
 * Unreachable providers (timeout / ECONNREFUSED / aborted fetch) are not
 * re-probed on that cadence: a per-provider circuit applies exponential
 * backoff (5s…5m) and latches at 5m after 5 consecutive transport failures.
 * A GET timeout does not fall back to HEAD — that doubled SYN storms through
 * HTTP proxies that ignore AbortController.
 */

import { getConfig } from '@los/infra/config';
import { getLogger } from '@los/infra/logger';
import {
  cacheHealthScore,
  computeHealthScore,
  type HealthScore,
  type HealthTier,
} from './provider-health.js';
import { MODEL_PROFILES } from '../model-profiles.js';
import { getRecentProviderOutcomes } from './telemetry.js';
import {
  getProviderProbeCircuit,
  isProviderProbeCircuitOpen,
  isTransportProbeFailure,
  noteProviderProbeFailure,
  noteProviderProbeSuccess,
  _resetProviderProbeCircuitsForTests,
} from './provider-probe-circuit.js';

const log = getLogger('provider-probe');

/** ADR 0043 exponential smoothing factor for RTT. */
const RTT_SMOOTH_ALPHA = 0.3;
const ACTIVE_PROBE_MS = 60_000;
const IDLE_PROBE_MS = 300_000;

// ── In-memory probe result cache ───────────────────────

const probeCache = new Map<string, ProbeResult>();
const lastTierByProvider = new Map<string, HealthTier>();
let recentSchedulingActivity = false;
let probeLoopTimer: ReturnType<typeof setTimeout> | null = null;
let probeLoopRunning = false;
let probeLoopStopped = true;
const probeInFlight = new Set<string>();

type ProbeFetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

interface ProbeDeps {
  fetch?: ProbeFetch;
  now?: () => number;
}

/** Get the latest cached probe result for a provider, or undefined. */
export function getCachedProbeResult(provider: string): ProbeResult | undefined {
  return probeCache.get(provider);
}

/** Get all cached probe results. */
export function getAllCachedProbeResults(): ProbeResult[] {
  return Array.from(probeCache.values());
}

/**
 * Mark that a scheduled task is in flight. The probe loop uses a faster
 * cadence (60s) while activity is recent, then falls back to 300s idle.
 */
export function markProviderProbeActivity(): void {
  recentSchedulingActivity = true;
}

export interface ProbeResult {
  provider: string;
  baseUrl: string;
  /** Round-trip time in milliseconds (exponentially smoothed when cached). */
  rttMs: number;
  /** HTTP status code (e.g. 200, 401, 503) */
  statusCode: number;
  /** Whether the probe succeeded (2xx response) */
  healthy: boolean;
  /** ISO timestamp of the probe */
  probedAt: string;
  /** Error message if probe failed */
  error?: string;
}

export interface ProbeTarget {
  provider: string;
  baseUrl: string;
  apiKey?: string;
  /** 走哪条线 —— 决定**探哪个 URL、用哪套健康判据**（见 `probeProvider`）。 */
  wire: 'openai' | 'anthropic';
}

/**
 * 这个 provider 走的是 Anthropic 的 `anthropic-messages` 线吗？
 *
 * 名字命中 `MODEL_PROFILES` 的（anthropic / claude / deepseek-anthropic / minimax）
 * 靠**名字**定线；自定义名字靠 config 里的 `apiShape` 覆盖。两者都要看。
 */
function isAnthropicWireProvider(provider: string, entry: { apiShape?: unknown }): boolean {
  if (entry.apiShape === 'anthropic-messages') return true;
  return MODEL_PROFILES[provider]?.protocol === 'anthropic';
}

/**
 * Resolve probe targets from the runtime config (enabled providers with a base URL).
 *
 * **按协议分派**：两个协议探不同的路径、用不同的健康判据。
 *
 * 起因（2026-10-12 实测）：探针原先一律打 `GET {baseUrl}/models` —— 那是 **OpenAI 兼容**
 * 协议的形状。Anthropic 协议的端点上它是 **404**（zenmux：`{base}/models` → 404），
 * 而 `404` 不在"ok | 401 | 403"这个健康判据里 ⇒ 判 `unhealthy`。
 * 而 `computeHealthScore` 把 `probe.healthy === false` 同时算成 `rttScore = 0`
 * 与 `availabilityScore = 0` ⇒ 即使真实调用 100% 成功，score 也只有
 * `0.4×0 + 0.4×1 + 0.2×0 = 0.40` < 0.5 ⇒ **`unhealthy`**，而 ADR 0031 会跳过 unhealthy
 * ⇒ **整个协议族被系统性误路由**（实测 `anthropic` 0.40、`deepseek-anthropic` 0.33，
 * 而它们真实调用都是 200）。
 *
 * 分派规则（**由实测给出，不是猜的**）：
 *
 * | 路径 | zenmux | deepseek |
 * |---|---|---|
 * | `{base}/models` | **404** | **401** |
 * | `{base}/v1/messages` | 404 | 401 |
 * | `{base}/v1/models` | 200 | — |
 *
 * ⇒ Anthropic 协议改用**协议自己的路径** `{base}/v1/messages`，判据放宽为
 * **任何 `< 500` 的 HTTP 应答 = 边缘可达**（探针在这里量的是**可用性**，权重 0.2；
 * **正确性**由真实调用结果承担，权重 0.4 —— 职责分开）；OpenAI 协议保持原判据不动。
 */
export function resolveConfiguredProbeTargets(): ProbeTarget[] {
  const config = getConfig();
  const targets: ProbeTarget[] = [];
  for (const [provider, entry] of Object.entries(config.providers ?? {})) {
    if (!entry || entry.enabled === false) continue;
    const baseUrl = typeof entry.baseUrl === 'string' ? entry.baseUrl.trim() : '';
    if (!baseUrl) continue;
    targets.push({
      provider,
      baseUrl,
      apiKey: typeof entry.apiKey === 'string' ? entry.apiKey : undefined,
      wire: isAnthropicWireProvider(provider, entry) ? 'anthropic' : 'openai',
    });
  }
  return targets;
}

/**
 * Probe a provider's base URL — **按协议选路径与判据**。
 * Transport failures open the per-provider circuit; no HEAD fallback.
 *
 * Not exported: production and tests go through probeProviders().
 */
async function probeProvider(
  provider: string,
  baseUrl: string,
  apiKey?: string,
  timeoutMs = 5000,
  deps: ProbeDeps = {},
  wire: ProbeTarget['wire'] = 'openai',
): Promise<ProbeResult> {
  const started = (deps.now ?? Date.now)();
  const doFetch = deps.fetch ?? fetch;
  const headers: Record<string, string> = {
    'User-Agent': 'los-provider-probe/1.0',
  };
  if (apiKey) {
    headers['Authorization'] = `Bearer ${apiKey}`;
  }

  const root = baseUrl.replace(/\/+$/, '');
  // 两个协议探不同的路径：OpenAI 兼容用 `/models`；Anthropic 用**协议自己的**
  // `/v1/messages`（实测 zenmux 的 `/models` 是 404、`/v1/messages` 是 404/401，
  // 两者都证明边缘可达；而 `/v1/messages` 是协议正典路径，不依赖厂商是否顺手实现了 `/models`）。
  const probeUrl = wire === 'anthropic' ? `${root}/v1/messages` : `${root}/models`;
  // 健康判据也按协议分开：Anthropic 这边量的是**可用性**（权重 0.2），
  // 所以任何 `< 500` 的 HTTP 应答都算"边缘可达"；正确性由真实调用结果承担（权重 0.4）。
  // OpenAI 兼容保持原判据（ok | 401 | 403），不放宽 —— 那里 `/models` 是真的存在，
  // 放宽会让填错的 baseUrl 看起来健康。
  const isHealthy = (status: number): boolean =>
    wire === 'anthropic'
      ? status < 500
      : (status >= 200 && status < 300) || status === 401 || status === 403;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await doFetch(probeUrl, {
      method: 'GET',
      headers,
      signal: controller.signal,
    });

    const rttMs = Math.max(0, (deps.now ?? Date.now)() - started);

    if (isHealthy(response.status)) {
      log.debug(`${provider} probe (${wire}): ${rttMs}ms HTTP ${response.status}`);
      return {
        provider,
        baseUrl,
        rttMs,
        statusCode: response.status,
        healthy: true,
        probedAt: new Date(started + rttMs).toISOString(),
      };
    }

    log.debug(`${provider} probe (${wire}): ${rttMs}ms HTTP ${response.status} (unhealthy)`);
    return {
      provider,
      baseUrl,
      rttMs,
      statusCode: response.status,
      healthy: false,
      probedAt: new Date(started + rttMs).toISOString(),
      error: `HTTP ${response.status}`,
    };
  } catch (err) {
    const rttMs = Math.max(0, (deps.now ?? Date.now)() - started);
    const message = err instanceof Error ? err.message : String(err);
    log.debug(`${provider} probe failed: ${message} (${rttMs}ms)`);
    return {
      provider,
      baseUrl,
      rttMs,
      statusCode: 0,
      healthy: false,
      probedAt: new Date(started + rttMs).toISOString(),
      error: message,
    };
  } finally {
    clearTimeout(timer);
  }
}

function circuitSkipResult(
  target: ProbeTarget,
  now: number,
  reason: string,
): ProbeResult {
  const previous = probeCache.get(target.provider);
  const circuit = getProviderProbeCircuit(target.provider);
  return {
    provider: target.provider,
    baseUrl: target.baseUrl,
    rttMs: previous?.rttMs ?? 0,
    statusCode: 0,
    healthy: false,
    probedAt: previous?.probedAt ?? new Date(now).toISOString(),
    error: `${reason}: ${circuit?.lastError ?? previous?.error ?? 'skipped'}`,
  };
}

/**
 * Batch probe multiple providers in parallel.
 * Results are cached with RTT exponential smoothing and sorted healthy-first.
 * Open circuits and in-flight probes are skipped (no second TCP SYN).
 */
export async function probeProviders(
  // `wire` 可选：外部（测试/一次性探测）可以只给 provider+baseUrl，默认按 openai 兼容处理，
  // 与历史调用形状兼容。
  targets: Array<{ provider: string; baseUrl: string; apiKey?: string; wire?: ProbeTarget['wire'] }>,
  timeoutMs?: number,
  deps: ProbeDeps = {},
): Promise<ProbeResult[]> {
  const now = (deps.now ?? Date.now)();
  const pending: ProbeTarget[] = [];
  const skipped: ProbeResult[] = [];

  for (const raw of targets) {
    // 归一化：调用方不给 `wire` 时按 openai 兼容处理（与历史调用形状兼容）。
    const target: ProbeTarget = { ...raw, wire: raw.wire ?? 'openai' };
    if (probeInFlight.has(target.provider)) {
      skipped.push(circuitSkipResult(target, now, 'probe_in_flight'));
      continue;
    }
    if (isProviderProbeCircuitOpen(target.provider, now)) {
      skipped.push(circuitSkipResult(target, now, 'circuit_open'));
      continue;
    }
    pending.push(target);
  }

  const results = await Promise.allSettled(
    pending.map(async (t) => {
      probeInFlight.add(t.provider);
      try {
        const result = await probeProvider(t.provider, t.baseUrl, t.apiKey, timeoutMs, deps, t.wire);
        const observed = (deps.now ?? Date.now)();
        if (result.healthy) {
          noteProviderProbeSuccess(t.provider, observed);
        } else if (isTransportProbeFailure(result.error ?? '')) {
          const state = noteProviderProbeFailure(t.provider, result.error ?? 'transport', observed);
          if (state.latched && state.consecutiveFailures === 5) {
            log.warn(
              `provider probe circuit latched for ${t.provider} after ${state.consecutiveFailures} transport failures; next probe in 5m`,
            );
          }
        }
        return result;
      } finally {
        probeInFlight.delete(t.provider);
      }
    }),
  );

  const probes: ProbeResult[] = [...skipped];
  for (const r of results) {
    if (r.status === 'fulfilled') {
      probes.push(cacheProbeResult(r.value));
    }
  }

  probes.sort((a, b) => {
    if (a.healthy !== b.healthy) return a.healthy ? -1 : 1;
    return a.rttMs - b.rttMs;
  });

  return probes;
}

/**
 * Start the periodic provider probe loop (ADR 0043 cadence).
 * Safe to call multiple times — only one loop is active.
 * Returns a stop function for gateway onClose hooks.
 */
export function startProviderProbeLoop(options: {
  resolveTargets?: () => ProbeTarget[] | Promise<ProbeTarget[]>;
  onHealthChanged?: (event: ProviderHealthChangedEvent) => void | Promise<void>;
  activeIntervalMs?: number;
  idleIntervalMs?: number;
} = {}): () => void {
  if (!probeLoopStopped && probeLoopTimer) {
    return stopProviderProbeLoop;
  }
  probeLoopStopped = false;
  const activeMs = options.activeIntervalMs ?? ACTIVE_PROBE_MS;
  const idleMs = options.idleIntervalMs ?? IDLE_PROBE_MS;
  const resolveTargets = options.resolveTargets ?? resolveConfiguredProbeTargets;

  const scheduleNext = (delayMs: number) => {
    if (probeLoopStopped) return;
    probeLoopTimer = setTimeout(() => {
      void runProbeCycle().then((hadTargets) => {
        const wasActive = recentSchedulingActivity;
        if (wasActive) recentSchedulingActivity = false;
        const nextMs = wasActive || hadTargets ? activeMs : idleMs;
        scheduleNext(nextMs);
      });
    }, delayMs);
  };

  const runProbeCycle = async (): Promise<boolean> => {
    if (probeLoopRunning || probeLoopStopped) return false;
    probeLoopRunning = true;
    try {
      const targets = await resolveTargets();
      if (targets.length === 0) return false;
      const probes = await probeProviders(targets);
      // 用**真实调用结果**一起评分（窗口与选择侧一致：24h）。此前只传 probe
      // ⇒ 成功率恒为 1.0（"no outcome data → benefit of the doubt"），
      // 于是「探针能连、真实调用 401/410」的 provider 会被评成 healthy
      // （2026-10-12 实测 nvidia-nim / opencode-zen）。
      //
      // ⚠️ **查询失败 ≠ 窗口内无数据**：两者都会让评分器走"宽恕"分支，
      // 但前者意味着这次要修的假绿会**原样复现且不留痕**（2026-10-12 独立 review 指出）。
      // 所以这里必须把异常记下来，而不是 `.catch(() => undefined)` 静默吞掉。
      const outcomesFor = async (provider: string) => {
        try {
          return await getRecentProviderOutcomes(provider, 24);
        } catch (error) {
          log.warn(
            `Provider outcome lookup failed for ${provider} (health falls back to probe-only, `
            + `i.e. successRate=1.0 — NOT the same as "no recent calls"): `
            + `${error instanceof Error ? error.message : String(error)}`,
          );
          return undefined;
        }
      };
      for (const probe of probes) {
        const score = computeHealthScore(probe.provider, probe, await outcomesFor(probe.provider));
        cacheHealthScore(score);
        await emitTierChangeIfNeeded(score, options.onHealthChanged);
      }
      return true;
    } catch (error) {
      log.warn(`Provider probe cycle failed: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    } finally {
      probeLoopRunning = false;
    }
  };

  // First cycle soon after start (2s), then cadence.
  scheduleNext(2_000);
  return stopProviderProbeLoop;
}

/** Stop the periodic provider probe loop. */
export function stopProviderProbeLoop(): void {
  probeLoopStopped = true;
  if (probeLoopTimer) {
    clearTimeout(probeLoopTimer);
    probeLoopTimer = null;
  }
}

export interface ProviderHealthChangedEvent {
  type: 'provider.health_changed';
  provider: string;
  fromTier: HealthTier | null;
  toTier: HealthTier;
  score: number;
  at: string;
}

// ── Internal helpers ────────────────────────────────────

function cacheProbeResult(result: ProbeResult): ProbeResult {
  const previous = probeCache.get(result.provider);
  let rttMs = result.rttMs;
  if (previous && previous.rttMs > 0 && result.rttMs > 0) {
    rttMs = Math.round(
      RTT_SMOOTH_ALPHA * result.rttMs + (1 - RTT_SMOOTH_ALPHA) * previous.rttMs,
    );
  }
  const cached: ProbeResult = { ...result, rttMs };
  probeCache.set(result.provider, cached);
  return cached;
}

async function emitTierChangeIfNeeded(
  score: HealthScore,
  onHealthChanged?: (event: ProviderHealthChangedEvent) => void | Promise<void>,
): Promise<void> {
  const previous = lastTierByProvider.get(score.provider) ?? null;
  if (previous === score.tier) return;
  lastTierByProvider.set(score.provider, score.tier);
  const event: ProviderHealthChangedEvent = {
    type: 'provider.health_changed',
    provider: score.provider,
    fromTier: previous,
    toTier: score.tier,
    score: score.score,
    at: new Date().toISOString(),
  };
  log.info(
    `provider.health_changed ${event.provider}: ${event.fromTier ?? 'unknown'} → ${event.toTier} (score=${event.score})`,
  );
  await onHealthChanged?.(event);
}

/** Test-only: clear probe state between tests. */
export function _resetProviderProbeStateForTests(): void {
  stopProviderProbeLoop();
  probeCache.clear();
  lastTierByProvider.clear();
  recentSchedulingActivity = false;
  probeLoopRunning = false;
  probeInFlight.clear();
  _resetProviderProbeCircuitsForTests();
}
