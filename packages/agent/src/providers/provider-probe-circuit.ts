/**
 * Process-local circuit breaker for provider health probes.
 *
 * A down local/remote inference server (timeout, ECONNREFUSED) must not be
 * re-probed on the healthy-provider cadence. Pattern mirrors
 * `remote-executor-circuit.ts`: exponential backoff, then a latched 5-minute
 * half-open so turning the server back on is still detected.
 */

const PROBE_CIRCUIT_BASE_MS = 5_000;
const PROBE_CIRCUIT_MAX_MS = 5 * 60_000;
/** Consecutive transport failures before the open window sticks at max. */
const PROBE_CIRCUIT_LATCH_AFTER = 5;

export type ProviderProbeCircuitState = {
  consecutiveFailures: number;
  openUntil: number;
  lastError: string | null;
  lastFailureAt: number | null;
  lastSuccessAt: number | null;
  latched: boolean;
};

const circuits = new Map<string, ProviderProbeCircuitState>();

/** Pure exponential backoff: 5s → 10s → 20s → … capped at 5m. */
function providerProbeBackoffMs(
  consecutiveFailures: number,
  baseMs = PROBE_CIRCUIT_BASE_MS,
  maxMs = PROBE_CIRCUIT_MAX_MS,
): number {
  if (consecutiveFailures <= 0) return 0;
  const shift = Math.min(Math.max(consecutiveFailures - 1, 0), 10);
  return Math.min(maxMs, baseMs * (2 ** shift));
}

export function isTransportProbeFailure(message: string): boolean {
  return /ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|ECONNRESET|ETIMEDOUT|fetch failed|network|socket hang up|aborted|AbortError|TimeoutError|timeout/i
    .test(message);
}

export function isProviderProbeCircuitOpen(provider: string, now = Date.now()): boolean {
  const state = circuits.get(provider);
  if (!state) return false;
  return state.openUntil > now;
}

export function getProviderProbeCircuit(provider: string): ProviderProbeCircuitState | undefined {
  const state = circuits.get(provider);
  return state ? { ...state } : undefined;
}

export function noteProviderProbeSuccess(provider: string, now = Date.now()): void {
  circuits.set(provider, {
    consecutiveFailures: 0,
    openUntil: 0,
    lastError: null,
    lastFailureAt: circuits.get(provider)?.lastFailureAt ?? null,
    lastSuccessAt: now,
    latched: false,
  });
}

export function noteProviderProbeFailure(
  provider: string,
  error: string,
  now = Date.now(),
): ProviderProbeCircuitState {
  const prev = circuits.get(provider);
  const consecutiveFailures = (prev?.consecutiveFailures ?? 0) + 1;
  const latched = consecutiveFailures >= PROBE_CIRCUIT_LATCH_AFTER;
  const backoff = latched
    ? PROBE_CIRCUIT_MAX_MS
    : providerProbeBackoffMs(consecutiveFailures);
  const state: ProviderProbeCircuitState = {
    consecutiveFailures,
    openUntil: now + backoff,
    lastError: error.slice(0, 300),
    lastFailureAt: now,
    lastSuccessAt: prev?.lastSuccessAt ?? null,
    latched,
  };
  circuits.set(provider, state);
  return { ...state };
}

export function _resetProviderProbeCircuitsForTests(): void {
  circuits.clear();
}
