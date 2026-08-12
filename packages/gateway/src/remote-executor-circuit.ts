/**
 * Process-local circuit breaker for Mac/gateway → remote executor HTTP.
 *
 * Boot storms (e.g. 极空间 reboot): registry may still say online while :8090 is
 * not listening; file-sync triggers and auto-probe would otherwise hammer
 * Connection refused. Pattern mirrors executor file-sync list-refresh backoff.
 */

const REMOTE_CIRCUIT_BASE_MS = 5_000;
const REMOTE_CIRCUIT_MAX_MS = 5 * 60_000;
/** Heartbeat older than this ⇒ treat node as unavailable for outbound HTTP. */
const REMOTE_HEARTBEAT_STALE_MS = 45_000;

export type RemoteCircuitState = {
  consecutiveFailures: number;
  openUntil: number;
  lastError: string | null;
  lastFailureAt: number | null;
  lastSuccessAt: number | null;
};

const circuits = new Map<string, RemoteCircuitState>();

/** Pure exponential backoff: 5s → 10s → 20s → 40s → … capped at 5m. */
function remoteCircuitBackoffMs(
  consecutiveFailures: number,
  baseMs = REMOTE_CIRCUIT_BASE_MS,
  maxMs = REMOTE_CIRCUIT_MAX_MS,
): number {
  if (consecutiveFailures <= 0) return 0;
  // Shift so failure #1 = base, #2 = 2×base, … until maxMs.
  const shift = Math.min(Math.max(consecutiveFailures - 1, 0), 10);
  return Math.min(maxMs, baseMs * (2 ** shift));
}

function isConnectionRefusedError(message: string): boolean {
  return /ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|ECONNRESET|ETIMEDOUT|fetch failed|network|socket hang up|aborted/i
    .test(message);
}

export function isRemoteCircuitOpen(nodeId: string, now = Date.now()): boolean {
  const state = circuits.get(nodeId);
  if (!state) return false;
  return state.openUntil > now;
}

function getRemoteCircuit(nodeId: string): RemoteCircuitState | undefined {
  const state = circuits.get(nodeId);
  return state ? { ...state } : undefined;
}

export function noteRemoteExecutorSuccess(nodeId: string, now = Date.now()): void {
  circuits.set(nodeId, {
    consecutiveFailures: 0,
    openUntil: 0,
    lastError: null,
    lastFailureAt: circuits.get(nodeId)?.lastFailureAt ?? null,
    lastSuccessAt: now,
  });
}

export function noteRemoteExecutorFailure(
  nodeId: string,
  error: string,
  now = Date.now(),
): RemoteCircuitState {
  const prev = circuits.get(nodeId);
  const consecutiveFailures = (prev?.consecutiveFailures ?? 0) + 1;
  const backoff = remoteCircuitBackoffMs(consecutiveFailures);
  const state: RemoteCircuitState = {
    consecutiveFailures,
    openUntil: now + backoff,
    lastError: error.slice(0, 300),
    lastFailureAt: now,
    lastSuccessAt: prev?.lastSuccessAt ?? null,
  };
  circuits.set(nodeId, state);
  return { ...state };
}

/** True when lastHeartbeatAt is missing or older than staleMs. */
export function isHeartbeatStaleForOutbound(
  lastHeartbeatAt: string | Date | null | undefined,
  now = Date.now(),
  staleMs = REMOTE_HEARTBEAT_STALE_MS,
): boolean {
  if (lastHeartbeatAt == null) return true;
  const ts = typeof lastHeartbeatAt === 'string'
    ? Date.parse(lastHeartbeatAt)
    : lastHeartbeatAt.getTime();
  if (!Number.isFinite(ts)) return true;
  return now - ts > staleMs;
}

/** Test helper. */
export function _resetRemoteExecutorCircuitsForTests(): void {
  circuits.clear();
}
