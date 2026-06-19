/**
 * GA Circuit Breaker & Throttle — prevents runaway auto-fix loops.
 *
 * Two protections:
 *   1. No-op throttle: consecutive rounds with zero findings → downgrade cadence → pause
 *   2. Circuit breaker: consecutive failures with same error signature → HALF_OPEN → OPEN
 *
 * Inspired by lsclaw's no-op throttle (downgrade after 3 zero-finding rounds, pause after 5)
 * and its CIRCUIT_OPEN scheduler state for persistent errors.
 */
import type { GovernanceJob, CircuitState, GovernanceCadence } from './governance-jobs-types.js';

// ── Thresholds ────────────────────────────────────────────

/** Consecutive no-op rounds before downgrading cadence. */
const NOOP_DOWNGRADE_THRESHOLD = 3;
/** Consecutive no-op rounds before pausing the job entirely. */
const NOOP_PAUSE_THRESHOLD = 5;
/** Consecutive failures before circuit goes HALF_OPEN (next run is dry-run only). */
const FAILURE_HALF_OPEN_THRESHOLD = 3;
/** Consecutive failures before circuit opens (job paused). */
const FAILURE_OPEN_THRESHOLD = 5;
/** Milliseconds before HALF_OPEN auto-recovers to CLOSED. */
const HALF_OPEN_RECOVERY_MS = 24 * 60 * 60 * 1000; // 24 hours

export interface ThrottleDecision {
  action: 'run' | 'skip' | 'downgrade' | 'pause';
  reason: string;
  newCadence?: GovernanceCadence;
  newCircuitState?: CircuitState;
  newStatus?: 'paused';
}

/**
 * Decide whether this loop round should run, based on current throttle & circuit state.
 * Returns the action and any side-effects (cadence downgrade, circuit state change, pause).
 */
export function evaluateLoopGate(job: GovernanceJob): ThrottleDecision {
  // ── Circuit breaker: OPEN ──────────────────────────
  if (job.circuitState === 'open') {
    return {
      action: 'skip',
      reason: 'circuit open — job paused due to repeated failures',
    };
  }

  // ── Circuit breaker: HALF_OPEN ─────────────────────
  if (job.circuitState === 'half_open') {
    // Check if recovery window has elapsed
    if (job.circuitOpenedAt) {
      const elapsed = Date.now() - new Date(job.circuitOpenedAt).getTime();
      if (elapsed >= HALF_OPEN_RECOVERY_MS) {
        return {
          action: 'run',
          reason: 'circuit half_open → recovery window elapsed, allowing one attempt (dry-run)',
          newCircuitState: 'closed',
        };
      }
    }
    return {
      action: 'skip',
      reason: 'circuit half_open — waiting for recovery window',
    };
  }

  // ── Check consecutive failures threshold ───────────
  if (job.consecutiveFailures >= FAILURE_OPEN_THRESHOLD) {
    return {
      action: 'pause',
      reason: `consecutive failures ${job.consecutiveFailures} >= ${FAILURE_OPEN_THRESHOLD} — opening circuit`,
      newCircuitState: 'open',
      newStatus: 'paused',
    };
  }

  if (job.consecutiveFailures >= FAILURE_HALF_OPEN_THRESHOLD) {
    return {
      action: 'run',
      reason: `consecutive failures ${job.consecutiveFailures} >= ${FAILURE_HALF_OPEN_THRESHOLD} — switching to half_open (dry-run only next round)`,
      newCircuitState: 'half_open',
    };
  }

  // ── No-op throttle ─────────────────────────────────
  if (job.consecutiveNoOps >= NOOP_PAUSE_THRESHOLD) {
    return {
      action: 'pause',
      reason: `consecutive no-ops ${job.consecutiveNoOps} >= ${NOOP_PAUSE_THRESHOLD} — pausing job`,
      newStatus: 'paused',
    };
  }

  if (job.consecutiveNoOps >= NOOP_DOWNGRADE_THRESHOLD) {
    const downgradeMap: Record<string, GovernanceCadence> = {
      hourly: 'daily',
      daily: 'weekly',
      weekly: 'manual',
      manual: 'manual',
    };
    const newCadence = downgradeMap[job.cadence] ?? 'manual';
    if (newCadence !== job.cadence) {
      return {
        action: 'downgrade',
        reason: `consecutive no-ops ${job.consecutiveNoOps} >= ${NOOP_DOWNGRADE_THRESHOLD} — downgrading cadence from ${job.cadence} to ${newCadence}`,
        newCadence,
      };
    }
  }

  return { action: 'run', reason: 'all gates passed' };
}

/**
 * Compute the next throttle/circuit state values after a loop round completes.
 */
export function computeNextState(
  job: GovernanceJob,
  hadFindings: boolean,
  hadError: boolean,
): {
  consecutiveNoOps: number;
  consecutiveFailures: number;
  circuitState: CircuitState;
  circuitOpenedAt?: string;
} {
  let consecutiveNoOps = hadFindings ? 0 : job.consecutiveNoOps + 1;
  let consecutiveFailures = hadError ? job.consecutiveFailures + 1 : 0;
  let circuitState: CircuitState = job.circuitState;
  let circuitOpenedAt = job.circuitOpenedAt;

  // Circuit breaker transitions
  if (hadError && consecutiveFailures >= FAILURE_HALF_OPEN_THRESHOLD && circuitState === 'closed') {
    circuitState = 'half_open';
    circuitOpenedAt = new Date().toISOString();
  }
  if (hadError && consecutiveFailures >= FAILURE_OPEN_THRESHOLD) {
    circuitState = 'open';
    circuitOpenedAt = new Date().toISOString();
  }

  // Recovery: if circuit was half_open or open and the round succeeded,
  // reset the failure counter and close the circuit
  if (!hadError && (circuitState === 'half_open' || circuitState === 'open')) {
    circuitState = 'closed';
    consecutiveFailures = 0;
    circuitOpenedAt = undefined;
  }

  return { consecutiveNoOps, consecutiveFailures, circuitState, circuitOpenedAt };
}

/**
 * Check if a job should be auto-recovered from PAUSED status.
 * Called at sweep time for any paused job whose circuit was auto-opened.
 */
export function maybeAutoRecoverPaused(job: GovernanceJob): boolean {
  if (job.status !== 'paused') return false;
  if (job.circuitState === 'closed') return true;
  if (job.circuitState === 'open' && job.circuitOpenedAt) {
    const elapsed = Date.now() - new Date(job.circuitOpenedAt).getTime();
    if (elapsed >= HALF_OPEN_RECOVERY_MS) return true;
  }
  return false;
}
