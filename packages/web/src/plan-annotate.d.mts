export type PlanStep = {
  id?: string;
  title?: string;
  description?: string;
  dependsOnIds?: string[];
  editableSurfaces?: string[];
  completionCriteria?: string;
};

export type PlanAnnotation = {
  id: string;
  stepIndex: number;
  kind: 'note' | 'replace_title' | 'replace_description';
  text: string;
};

export type ReviewFinding = {
  id: string;
  path: string;
  line: number | null;
  side: 'old' | 'new' | 'both';
  severity: 'critical' | 'warning' | 'suggestion';
  note: string;
};

export function applyPlanAnnotations(plan: PlanStep[], annotations: PlanAnnotation[]): PlanStep[];
export function summarizePlanAnnotations(annotations: PlanAnnotation[]): string;
export function summarizeReviewFindings(findings: ReviewFinding[]): string;
export function composeOperatorReason(
  baseReason: string,
  annotations: PlanAnnotation[],
  findings?: ReviewFinding[],
): string;
export function createPlanAnnotation(
  input: Partial<PlanAnnotation> & { stepIndex: number; kind: PlanAnnotation['kind']; text: string },
): PlanAnnotation;
export function createReviewFinding(
  input: Partial<ReviewFinding> & { path: string; note: string; severity: ReviewFinding['severity'] },
): ReviewFinding;
