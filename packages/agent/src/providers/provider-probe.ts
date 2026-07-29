/**
 * @los/agent/providers/provider-probe — Lightweight provider health check with RTT measurement.
 *
 * VPS Autopilot insight: the lowest-cost, highest-reward improvement is adding
 * RTT timing to the provider probe. An HTTP HEAD or cheap /models request
 * costs one round-trip and gives the scheduler real-time latency data.
 *
 * Design: fire-and-forget, non-blocking. Probe results are stored in metadata
 * and surfaced through the readiness API. A failed probe does NOT block
 * provider usage — it only affects the scheduler's preference ranking.
 */

import { getLogger } from '@los/infra/logger';

const log = getLogger('provider-probe');

// ── In-memory probe result cache ───────────────────────
// Updated by probeProvider() after each successful or failed probe.
// Read by the scheduler for health-aware routing decisions without
// blocking task dispatch on live HTTP probes.

const probeCache = new Map<string, ProbeResult>();

/** Get the latest cached probe result for a provider, or undefined. */
export function getCachedProbeResult(provider: string): ProbeResult | undefined {
  return probeCache.get(provider);
}

/** Get all cached probe results. */
export function getAllCachedProbeResults(): ProbeResult[] {
  return Array.from(probeCache.values());
}

export interface ProbeResult {
  provider: string;
  baseUrl: string;
  /** Round-trip time in milliseconds */
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

/**
 * Probe a provider's base URL with a lightweight request.
 * Uses the /models endpoint when available (OpenAI-compatible),
 * falls back to HTTP HEAD on the base URL.
 *
 * @param provider - Provider name (e.g. 'kimi', 'deepseek')
 * @param baseUrl - Provider API base URL
 * @param apiKey - API key for authentication
 * @param timeoutMs - Request timeout (default 5000)
 */
export async function probeProvider(
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

  // Try GET /models (OpenAI-compatible) — cheapest endpoint
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

    // 401/403 = API key valid but insufficient permissions — still "healthy" for probe purposes
    if (response.status === 401 || response.status === 403) {
      log.debug(`${provider} probe: ${rttMs}ms HTTP ${response.status} (auth gated, reachable)`);
      return {
        provider,
        baseUrl,
        rttMs,
        statusCode: response.status,
        healthy: true, // reachable even if auth-gated
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

    // Fallback: HTTP HEAD on base URL (no auth)
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
 * Returns results in the order they complete (fastest first for
 * scheduler preference ranking).
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
      // Cache the result for scheduler health-aware routing
      probeCache.set(r.value.provider, r.value);
      probes.push(r.value);
    }
  }

  // Sort: healthy first, then by ascending RTT
  probes.sort((a, b) => {
    if (a.healthy !== b.healthy) return a.healthy ? -1 : 1;
    return a.rttMs - b.rttMs;
  });

  return probes;
}
