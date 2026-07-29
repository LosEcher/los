/**
 * @los/agent/providers/provider-probe — Lightweight provider health check with RTT measurement.
 *
 * Design: fire-and-forget, non-blocking. Probe results are cached and
 * surface into health-aware routing (ADR 0031). A failed probe does NOT block
 * provider usage — it only affects preference ranking and fallback skips.
 *
 * Cadence (ADR 0031): 60s while scheduling is active, 300s when idle.
 * RTT is exponentially smoothed (α=0.3) so scores do not thrash.
 */

import { getConfig } from '@los/infra/config';
import { getLogger } from '@los/infra/logger';
import {
  cacheHealthScore,
  computeHealthScore,
  type HealthScore,
  type HealthTier,
} from './provider-health.js';

const log = getLogger('provider-probe');

/** ADR 0031 exponential smoothing factor for RTT. */
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
 * Resolve probe targets from the runtime config (enabled providers with a base URL).
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
    });
  }
  return targets;
}

/**
 * Probe a provider's base URL with a lightweight request.
 * Uses the /models endpoint when available (OpenAI-compatible),
 * falls back to HTTP HEAD on the base URL.
 *
 * Not exported: production and tests go through probeProviders().
 */
async function probeProvider(
  provider: string,
  baseUrl: string,
  apiKey?: string,
  timeoutMs = 5000,
): Promise<ProbeResult> {
  const started = Date.now();
  const headers: Record<string, string> = {
    'User-Agent': 'los-provider-probe/1.0',
  };
  if (apiKey) {
    headers['Authorization'] = `Bearer ${apiKey}`;
  }

  const modelsUrl = `${baseUrl.replace(/\/+$/, '')}/models`;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    const response = await fetch(modelsUrl, {
      method: 'GET',
      headers,
      signal: controller.signal,
    });
    clearTimeout(timer);

    const rttMs = Date.now() - started;

    if (response.ok) {
      log.debug(`${provider} probe: ${rttMs}ms HTTP ${response.status}`);
      return {
        provider,
        baseUrl,
        rttMs,
        statusCode: response.status,
        healthy: true,
        probedAt: new Date().toISOString(),
      };
    }

    // 401/403 = reachable even if auth-gated
    if (response.status === 401 || response.status === 403) {
      log.debug(`${provider} probe: ${rttMs}ms HTTP ${response.status} (auth gated, reachable)`);
      return {
        provider,
        baseUrl,
        rttMs,
        statusCode: response.status,
        healthy: true,
        probedAt: new Date().toISOString(),
      };
    }

    log.debug(`${provider} probe: ${rttMs}ms HTTP ${response.status} (unhealthy)`);
    return {
      provider,
      baseUrl,
      rttMs,
      statusCode: response.status,
      healthy: false,
      probedAt: new Date().toISOString(),
      error: `HTTP ${response.status}`,
    };
  } catch (err) {
    const rttMs = Date.now() - started;
    const message = err instanceof Error ? err.message : String(err);

    try {
      const controller2 = new AbortController();
      const timer2 = setTimeout(() => controller2.abort(), Math.min(timeoutMs, 3000));
      const headResponse = await fetch(baseUrl, {
        method: 'HEAD',
        signal: controller2.signal,
      });
      clearTimeout(timer2);
      const headRtt = Date.now() - started;

      log.debug(`${provider} HEAD probe: ${headRtt}ms HTTP ${headResponse.status}`);
      return {
        provider,
        baseUrl,
        rttMs: headRtt,
        statusCode: headResponse.status,
        healthy: headResponse.status < 500,
        probedAt: new Date().toISOString(),
      };
    } catch {
      log.debug(`${provider} probe failed: ${message} (${rttMs}ms)`);
      return {
        provider,
        baseUrl,
        rttMs,
        statusCode: 0,
        healthy: false,
        probedAt: new Date().toISOString(),
        error: message,
      };
    }
  }
}

/**
 * Batch probe multiple providers in parallel.
 * Results are cached with RTT exponential smoothing and sorted healthy-first.
 */
export async function probeProviders(
  targets: Array<{ provider: string; baseUrl: string; apiKey?: string }>,
  timeoutMs?: number,
): Promise<ProbeResult[]> {
  const results = await Promise.allSettled(
    targets.map(t => probeProvider(t.provider, t.baseUrl, t.apiKey, timeoutMs)),
  );

  const probes: ProbeResult[] = [];
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
 * Start the periodic provider probe loop (ADR 0031 cadence).
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
      for (const probe of probes) {
        const score = computeHealthScore(probe.provider, probe);
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
}
