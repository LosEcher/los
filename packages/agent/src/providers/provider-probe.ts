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
 * ⚠️ **`anthropic-messages` 的 provider 不在靶内** —— 判据是「**探不了 ≠ 坏**」。
 *
 * 探针只打 `GET {baseUrl}/models`，那是 **OpenAI 兼容**协议的形状；Anthropic 协议的
 * 端点上没有这个路径 ⇒ 探针**必然**失败。而 `computeHealthScore` 把
 * `probe.healthy === false` 同时算成 `rttScore = 0` 与 `availabilityScore = 0`
 * ⇒ 即使真实调用 100% 成功，score 也只有 `0.4×0 + 0.4×1 + 0.2×0 = 0.40` < 0.5
 * ⇒ **`unhealthy`**，而 ADR 0031 的选择逻辑会跳过 unhealthy
 * ⇒ **整个协议族被系统性误路由**（不是个别噪声）。
 *
 * 2026-10-12 实测：`deepseek-anthropic` 探针 `unhealthy`(0.27~0.4) 而真实调用 **200**；
 * 新接入的 `anthropic` 同样 0.4。
 *
 * 排除之后评分器走 no-probe 的中性分支（rttScore 0.5 / availability 0.5）
 * ⇒ 真实成功率 1 时 score = `0.2 + 0.4 + 0.1 = 0.70` = **`degraded`**（不再被跳过）。
 * 真正的修（**按协议分派探针**：Anthropic 打 `/v1/messages`）另做 —— 那时才有真
 * `rttMs`，这类 provider 才能上到 `healthy`。
 */
export function resolveConfiguredProbeTargets(): ProbeTarget[] {
  return partitionProbeCandidates().probeable;
}

/**
 * 与 `resolveConfiguredProbeTargets` **互补**：仍在用、但**不可探**的 provider。
 *
 * 为什么不直接把它们从健康面里剔除：那样 `/providers/health` 会**整条不见**
 * （健康条目由探针循环填缓存）⇒ 等于拿"误判成 unhealthy"换"看不见"，
 * 而看不见会让真实在坏的 provider 也无从发现（2026-10-12 实测：剔除后
 * anthropic / deepseek-anthropic / minimax / zenmux-claude 四家从列表里消失）。
 *
 * 正确做法：**照样算分，只是不给它 probe** ⇒ `computeHealthScore(provider, undefined, outcomes)`
 * 走 no-probe 的中性分支，条目仍在、`hasProbe:false` 如实可见、分数由真实调用决定。
 */
function resolveUnprobableProviders(): Array<{ provider: string }> {
  return partitionProbeCandidates().unprobable.map(x => ({ provider: x.provider }));
}

function partitionProbeCandidates(): {
  probeable: ProbeTarget[];
  unprobable: ProbeTarget[];
} {
  const config = getConfig();
  const probeable: ProbeTarget[] = [];
  const unprobable: ProbeTarget[] = [];
  for (const [provider, entry] of Object.entries(config.providers ?? {})) {
    if (!entry || entry.enabled === false) continue;
    const baseUrl = typeof entry.baseUrl === 'string' ? entry.baseUrl.trim() : '';
    if (!baseUrl) continue;
    const ref: ProbeTarget = {
      provider,
      baseUrl,
      apiKey: typeof entry.apiKey === 'string' ? entry.apiKey : undefined,
    };
    if (isAnthropicWireProvider(provider, entry)) unprobable.push(ref);
    else probeable.push(ref);
  }
  if (unprobable.length > 0) {
    // 说清楚"为什么没有 probe"——否则 `hasProbe:false` 看起来像探针漏了这几家。
    log.debug(
      `Not probed (GET /models does not exist on the anthropic-messages wire; `
      + `health is computed from real-call outcomes instead): ${unprobable.map(x => x.provider).join(', ')}`,
    );
  }
  return { probeable, unprobable };
}

/**
 * Probe a provider's base URL with a lightweight GET /models.
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
): Promise<ProbeResult> {
  const started = (deps.now ?? Date.now)();
  const doFetch = deps.fetch ?? fetch;
  const headers: Record<string, string> = {
    'User-Agent': 'los-provider-probe/1.0',
  };
  if (apiKey) {
    headers['Authorization'] = `Bearer ${apiKey}`;
  }

  const modelsUrl = `${baseUrl.replace(/\/+$/, '')}/models`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await doFetch(modelsUrl, {
      method: 'GET',
      headers,
      signal: controller.signal,
    });

    const rttMs = Math.max(0, (deps.now ?? Date.now)() - started);

    if (response.ok || response.status === 401 || response.status === 403) {
      log.debug(`${provider} probe: ${rttMs}ms HTTP ${response.status}`);
      return {
        provider,
        baseUrl,
        rttMs,
        statusCode: response.status,
        healthy: true,
        probedAt: new Date(started + rttMs).toISOString(),
      };
    }

    log.debug(`${provider} probe: ${rttMs}ms HTTP ${response.status} (unhealthy)`);
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
  targets: Array<{ provider: string; baseUrl: string; apiKey?: string }>,
  timeoutMs?: number,
  deps: ProbeDeps = {},
): Promise<ProbeResult[]> {
  const now = (deps.now ?? Date.now)();
  const pending: ProbeTarget[] = [];
  const skipped: ProbeResult[] = [];

  for (const target of targets) {
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
        const result = await probeProvider(t.provider, t.baseUrl, t.apiKey, timeoutMs, deps);
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
      const scored = new Set<string>();
      for (const probe of probes) {
        scored.add(probe.provider);
        const score = computeHealthScore(probe.provider, probe, await outcomesFor(probe.provider));
        cacheHealthScore(score);
        await emitTierChangeIfNeeded(score, options.onHealthChanged);
      }
      // **不可探**的 provider（anthropic-messages 那几家）照样算分，只是不给 probe。
      // 不这么做它们会从 `/providers/health` **整条消失**（条目由本循环填缓存）——
      // 那是拿"误判成 unhealthy"换"看不见"，而看不见会让真实在坏的也无从发现。
      // 走 no-probe 的中性分支 ⇒ 分数只由真实调用决定：成功率 1 ⇒ 0.70 = `degraded`
      // ⇒ 不再被 ADR 0031 的"跳过 unhealthy"命中。
      for (const { provider } of resolveUnprobableProviders()) {
        if (scored.has(provider)) continue;
        const score = computeHealthScore(provider, undefined, await outcomesFor(provider));
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
