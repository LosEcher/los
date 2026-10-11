/**
 * @los/agent/run-phase-values — the `RunPhase` closed set and its normalizer.
 *
 * Extracted so `run-phase-ledger.ts` can classify a phase without importing the
 * whole contract module (the contract module sits close to the 700-line structure
 * gate, and a cycle between the two would be worse than a tiny leaf module).
 *
 * The set is deliberately closed: there is no `not_applicable` and no `completed`.
 * A phase-exempt contract says so through `phaseTracking` / `phaseExemptReason`
 * instead — see docs/architecture/2026-10-10-control-plane-truth-remediation.md §6.
 */

export type RunPhase =
  | 'created'
  | 'discovering'
  | 'discovery_ready'
  | 'planning'
  | 'plan_approved'
  | 'executing'
  | 'verifying'
  | 'succeeded'
  | 'blocked'
  | 'failed'
  | 'cancelled';

const RUN_PHASE_VALUES: readonly RunPhase[] = [
  'created',
  'discovering',
  'discovery_ready',
  'planning',
  'plan_approved',
  'executing',
  'verifying',
  'succeeded',
  'blocked',
  'failed',
  'cancelled',
];

/** Unknown or non-string values become `undefined` — never a placeholder phase. */
export function normalizeRunPhase(value: unknown): RunPhase | undefined {
  if (typeof value !== 'string') return undefined;
  return (RUN_PHASE_VALUES as readonly string[]).includes(value) ? (value as RunPhase) : undefined;
}
