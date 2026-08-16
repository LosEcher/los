export interface PlanStep {
  id: string;
  title: string;
  description: string;
  dependsOnIds: string[];
  editableSurfaces: string[];
  completionCriteria: string;
}

/**
 * Independence level of a verification check, i.e. how far the check's
 * evidence stands from the executing model's own judgment.
 *
 * - `deterministic`: machine-checked command/assertion (pnpm check, contract
 *   gates, mutation tests) — strongest evidence.
 * - `separate_model`: reviewed by a different model/provider than the one
 *   that produced the work — independent but model-related.
 * - `same_model`: the executing model's self-review — weakest model evidence.
 * - `unknown`: not declared (default). Kept explicit so quality panels cannot
 *   mistake an undeclared check for an independent one.
 */
export type VerificationIndependence = 'deterministic' | 'separate_model' | 'same_model' | 'unknown';

export interface VerificationRequirement {
  id: string;
  kind: 'command' | 'assertion' | 'operator_review';
  description: string;
  command?: string;
  assertion?: string;
  reviewer?: string;
  /** Independence level of this check. Defaults to 'unknown' when absent. */
  independence?: VerificationIndependence;
}

export interface PlanRevisionSnapshot {
  revision: number;
  plan: PlanStep[];
  requiredChecks: string[];
  verifications: VerificationRequirement[];
  supersededAt: string;
  actor?: string;
  reason?: string;
}
