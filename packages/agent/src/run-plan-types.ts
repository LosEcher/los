export interface PlanStep {
  id: string;
  title: string;
  description: string;
  dependsOnIds: string[];
  editableSurfaces: string[];
  completionCriteria: string;
}

export interface VerificationRequirement {
  id: string;
  kind: 'command' | 'assertion' | 'operator_review';
  description: string;
  command?: string;
  assertion?: string;
  reviewer?: string;
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
