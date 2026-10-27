/**
 * @los/agent/run-phase-gate — the write-side gate for phase bookkeeping.
 *
 * Extracted from `run-specs.ts` for the 700-line structure gate. Behaviour is
 * unchanged; `createRunSpec` calls {@link applyPhaseTrackingGate} on the **raw**
 * contract before normalization.
 *
 * See docs/architecture/2026-10-10-control-plane-truth-remediation.md §6.
 */

import type {
  PhaseExemptReason,
  PhaseTracking,
} from './run-phase-ledger.js';
import type { RunContractMetadataInput } from './run-contract.js';
import type { RunPhase } from './run-phase-values.js';

/**
 * Phase bookkeeping gate for **new** rows (truth remediation §6).
 *
 * Three inputs are separated on purpose:
 *
 *   1. no `phase` key and no declared marker -> `exempt` + `writer_omitted`.
 *      Never throws: a writing path that forgot is still recorded, and the
 *      omission becomes a counted, visible defect instead of a silent NULL.
 *   2. a legal `RunPhase` and no marker            -> `tracked`.
 *   3. a `phase` key whose value is not a `RunPhase` (including `completed` and
 *      `not_applicable`) -> throws, before normalization can drop the string and
 *      disguise the caller's bug as legacy history.
 *
 * Historical rows are never rewritten by this gate; it only sees new writes.
 */
export function applyPhaseTrackingGate(
  contract: RunContractMetadataInput | undefined,
  declaredReason?: PhaseExemptReason,
): RunContractMetadataInput | undefined {
  if (declaredReason !== undefined) {
    // Validate eagerly so a typo fails here rather than being dropped later.
    if (!PHASE_EXEMPT_REASONS.has(declaredReason)) {
      throw new Error(
        `Unknown phaseExemptReason '${String(declaredReason)}'; expected one of ${[...PHASE_EXEMPT_REASONS].join(', ')}`,
      );
    }
  }
  // A missing or non-object contract is still a write that must be classified.
  // Returning early here (the original shape) left `run_contract_json` as `{}` —
  // the exact "no phase and no marker" row the gate exists to eliminate. The
  // object is therefore synthesised from an empty draft.
  const draft: Record<string, unknown> = contract && typeof contract === 'object' && !Array.isArray(contract)
    ? { ...(contract as Record<string, unknown>) }
    : {};
  const hasPhaseKey = Object.prototype.hasOwnProperty.call(draft, 'phase');
  const rawPhase = draft.phase;
  const phaseText = typeof rawPhase === 'string' ? rawPhase.trim() : '';

  if (hasPhaseKey && phaseText.length > 0 && !isRunPhaseText(phaseText)) {
    throw new Error(
      `run-spec contract validation failed: /runContract/phase must be one of the RunPhase values, got '${phaseText}'`,
    );
  }

  const existingTracking = draft.phaseTracking;
  const existingReason = draft.phaseExemptReason;

  if (isRunPhaseText(phaseText)) {
    // A real phase wins; the marker is derived, not invented.
    draft.phaseTracking = 'tracked';
    delete draft.phaseExemptReason;
    return draft as RunContractMetadataInput;
  }

  if (existingTracking === 'exempt') {
    // Keep a declared exemption, and let the caller-supplied reason fill a gap
    // rather than overwriting an existing one (openai_compat must keep winning
    // over chat_without_phase).
    const reason = existingReason ?? declaredReason ?? 'writer_omitted';
    if (!PHASE_EXEMPT_REASONS.has(reason as PhaseExemptReason)) {
      throw new Error(
        `Unknown phaseExemptReason '${String(reason)}'; expected one of ${[...PHASE_EXEMPT_REASONS].join(', ')}`,
      );
    }
    draft.phaseTracking = 'exempt';
    draft.phaseExemptReason = reason;
    return draft as RunContractMetadataInput;
  }

  draft.phaseTracking = 'exempt';
  draft.phaseExemptReason = declaredReason ?? (typeof existingReason === 'string' && existingReason
    ? existingReason
    : 'writer_omitted');
  return draft as RunContractMetadataInput;
}

const RUN_PHASE_VALUES = new Set<string>([
  'created', 'discovering', 'discovery_ready', 'planning', 'plan_approved',
  'executing', 'verifying', 'succeeded', 'blocked', 'failed', 'cancelled',
]);

function isRunPhaseText(value: string): value is RunPhase {
  return RUN_PHASE_VALUES.has(value);
}

const PHASE_EXEMPT_REASONS = new Set<PhaseExemptReason>([
  'openai_compat', 'feed_analysis_ingress', 'chat_without_phase',
  'subagent_inherited', 'work_item_draft', 'scenario_runner', 'writer_omitted',
]);

/** What the caller declares when it knowingly writes a phase-exempt contract. */
export type CreateRunSpecExemption = {
  phaseTracking?: PhaseTracking;
  phaseExemptReason?: PhaseExemptReason;
};
