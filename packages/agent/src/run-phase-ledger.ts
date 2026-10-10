/**
 * @los/agent/run-phase-ledger — phase bookkeeping truth and classification.
 *
 * Extracted from `run-contract.ts` for the 700-line structure gate. It was
 * `run-contract.ts:704+` before extraction; the module boundary here is a file
 * size artefact, not a design boundary.
 *
 * Two jobs:
 *
 *  1. The `phaseTracking` / `phaseExemptReason` vocabulary — a **sidecar** marker
 *     that says whether `phase` is lifecycle truth, and why not when it is not.
 *     It is never a phase value: `normalizeRunPhase` drops unknown strings, so a
 *     `not_applicable` phase would normalize away and any non-RunPhase value
 *     would make terminal rows look permanently drifted.
 *
 *  2. `classifyPhaseLedger` — the single predicate shared by the governance
 *     report and `tools/audit-run-state-drift.ts`, so the two instruments cannot
 *     disagree. It reads the **raw** `run_contract_json`: normalizing first would
 *     turn an illegal string such as `"completed"` into `undefined` and misreport
 *     a caller's write bug as history.
 *
 * See docs/architecture/2026-10-10-control-plane-truth-remediation.md §6.
 */

import { normalizeRunPhase, type RunPhase } from './run-phase-values.js';

/**
 * Whether a contract participates in the phase lifecycle.
 *
 * `tracked` — `phase` is lifecycle truth. `exempt` — the writing path does not
 * participate; `phaseExemptReason` says why.
 */
export type PhaseTracking = 'tracked' | 'exempt';

/**
 * Why a contract is phase-exempt. `writer_omitted` is the safety net for a
 * writing path that set neither a phase nor a reason: it is a write-side defect
 * signal counted separately by the governance report, not a legitimate
 * exemption. It is also the only reason the gate assigns automatically.
 */
export type PhaseExemptReason =
  | 'openai_compat'
  | 'feed_analysis_ingress'
  | 'chat_without_phase'
  | 'subagent_inherited'
  | 'work_item_draft'
  | 'scenario_runner'
  | 'writer_omitted';

const PHASE_TRACKING_VALUES: readonly PhaseTracking[] = ['tracked', 'exempt'];
const PHASE_EXEMPT_REASONS: readonly PhaseExemptReason[] = [
  'openai_compat',
  'feed_analysis_ingress',
  'chat_without_phase',
  'subagent_inherited',
  'work_item_draft',
  'scenario_runner',
  'writer_omitted',
];

export function normalizePhaseTracking(value: unknown): PhaseTracking | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return PHASE_TRACKING_VALUES.includes(trimmed as PhaseTracking) ? (trimmed as PhaseTracking) : undefined;
}

/**
 * Strict form: unlike the rest of the metadata normalizer, an unknown reason is
 * **not** silently dropped. A typo must fail loudly rather than be collected into
 * `writer_omitted`, which would turn a broken call site into a plausible one.
 */
export function parsePhaseExemptReason(value: unknown): PhaseExemptReason | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const trimmed = typeof value === 'string' ? value.trim() : '';
  if (!PHASE_EXEMPT_REASONS.includes(trimmed as PhaseExemptReason)) {
    throw new Error(
      `Unknown phaseExemptReason '${String(value)}'; expected one of ${PHASE_EXEMPT_REASONS.join(', ')}`,
    );
  }
  return trimmed as PhaseExemptReason;
}

/**
 * Why a run_spec's phase bookkeeping looks the way it does.
 *
 * Read this from the **raw** `run_contract_json`, never from
 * `normalizeRunContractMetadata` output: normalization turns an illegal string
 * such as `"completed"` into `undefined`, which would then be misreported as
 * `legacy_untracked` — a second false negative of the same family the audit
 * found (the first was `phase NOT IN (...)` dropping NULL rows).
 */
export type PhaseLedgerBucket =
  | 'illegal_phase'
  | 'real_drift'
  | 'legacy_untracked'
  | 'exempt'
  | 'exempt_unspecified'
  | 'consistent';

export type PhaseLedgerClassification = {
  bucket: PhaseLedgerBucket;
  /** Present only for `illegal_phase`: the offending text, verbatim. */
  illegalPhase?: string;
  /** Present only for `real_drift`: which predicate fired. */
  driftReason?: string;
};

const TERMINAL_RUN_STATUSES = new Set(['succeeded', 'failed', 'cancelled']);
const PRE_EXECUTION_PHASES = new Set(['created', 'discovering', 'discovery_ready', 'planning']);

/**
 * Classify one row. Pure: takes the raw contract JSON and the run status, returns
 * a bucket. The drift predicates intentionally mirror
 * `validatePhaseStatusConsistency`, plus the `blocked` rule that function does not
 * check (the drift script does) — sharing this function is what keeps the two
 * instruments from disagreeing.
 */
export function _classifyPhaseLedgerForTests(
  rawContract: unknown,
  runStatus: string | undefined,
): PhaseLedgerClassification {
  const raw = rawContract && typeof rawContract === 'object' && !Array.isArray(rawContract)
    ? (rawContract as Record<string, unknown>)
    : {};
  const rawPhase = raw.phase;
  const hasPhaseKey = Object.prototype.hasOwnProperty.call(raw, 'phase');
  const phaseText = typeof rawPhase === 'string' ? rawPhase.trim() : '';

  if (hasPhaseKey && phaseText.length > 0 && !isRunPhase(phaseText)) {
    // A non-empty, non-RunPhase string. `completed` / `not_applicable` land here.
    return { bucket: 'illegal_phase', illegalPhase: phaseText };
  }

  const phase = normalizeRunPhase(rawPhase);
  if (phase) {
    const driftReason = phaseDriftReason(phase, runStatus);
    if (driftReason) return { bucket: 'real_drift', driftReason };
    return { bucket: 'consistent' };
  }

  // No usable phase. Distinguish "declared exempt" from "nobody said anything".
  const tracking = normalizePhaseTracking(raw.phaseTracking);
  const reason = normalizePhaseExemptReasonLenient(raw.phaseExemptReason);
  if (tracking === 'exempt' && reason && reason !== 'writer_omitted') return { bucket: 'exempt' };
  if (reason === 'writer_omitted') return { bucket: 'exempt_unspecified' };
  if (tracking === 'exempt') return { bucket: 'exempt_unspecified' };
  return { bucket: 'legacy_untracked' };
}

function isRunPhase(value: string): value is RunPhase {
  return normalizeRunPhase(value) !== undefined;
}

/** Same predicates as `validatePhaseStatusConsistency`, plus the blocked rule. */
function phaseDriftReason(phase: RunPhase, runStatus: string | undefined): string | undefined {
  const status = runStatus?.trim() ?? '';
  if (!status) return undefined;
  if (TERMINAL_RUN_STATUSES.has(status) && phase !== status) {
    return `status '${status}' but phase '${phase}'`;
  }
  if (TERMINAL_RUN_STATUSES.has(phase) && phase !== status) {
    return `phase '${phase}' but status '${status}'`;
  }
  if (status === 'running' && PRE_EXECUTION_PHASES.has(phase)) {
    return `status 'running' but phase '${phase}'`;
  }
  if (status === 'blocked' && phase !== 'blocked') {
    return `status 'blocked' but phase '${phase}'`;
  }
  return undefined;
}

/**
 * Lenient read used only by the classifier: an unknown reason is reported as
 * "no reason" so a row that predates the enum is classified instead of throwing.
 * `createRunSpec` uses the strict `parsePhaseExemptReason` instead.
 */
function normalizePhaseExemptReasonLenient(value: unknown): PhaseExemptReason | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return PHASE_EXEMPT_REASONS.includes(trimmed as PhaseExemptReason)
    ? (trimmed as PhaseExemptReason)
    : undefined;
}
