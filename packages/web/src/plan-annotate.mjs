/**
 * Pure helpers for plan annotations and review findings (Plannotator-class).
 * Used by Work/Chat UI; no React dependency.
 */

/**
 * @typedef {{ id?: string, title?: string, description?: string, dependsOnIds?: string[], editableSurfaces?: string[], completionCriteria?: string }} PlanStep
 * @typedef {{ id: string, stepIndex: number, kind: 'note' | 'replace_title' | 'replace_description', text: string }} PlanAnnotation
 * @typedef {{ id: string, path: string, line: number | null, side: 'old' | 'new' | 'both', severity: 'critical' | 'warning' | 'suggestion', note: string }} ReviewFinding
 */

/**
 * @param {PlanStep[]} plan
 * @param {PlanAnnotation[]} annotations
 * @returns {PlanStep[]}
 */
export function applyPlanAnnotations(plan, annotations) {
  if (!Array.isArray(plan) || plan.length === 0) return [];
  const next = plan.map(step => ({ ...step }));
  for (const annotation of annotations) {
    const step = next[annotation.stepIndex];
    if (!step) continue;
    if (annotation.kind === 'replace_title' && annotation.text.trim()) {
      step.title = annotation.text.trim();
    } else if (annotation.kind === 'replace_description' && annotation.text.trim()) {
      step.description = annotation.text.trim();
    } else if (annotation.kind === 'note' && annotation.text.trim()) {
      const stamp = `[operator note] ${annotation.text.trim()}`;
      step.description = step.description ? `${step.description}\n\n${stamp}` : stamp;
    }
  }
  return next;
}

/**
 * @param {PlanAnnotation[]} annotations
 * @returns {string}
 */
export function summarizePlanAnnotations(annotations) {
  if (!annotations.length) return '';
  return annotations.map((item, index) => {
    const kind =
      item.kind === 'replace_title' ? 'title'
        : item.kind === 'replace_description' ? 'description'
          : 'note';
    return `${index + 1}. step ${item.stepIndex + 1} (${kind}): ${item.text.trim()}`;
  }).join('\n');
}

/**
 * @param {ReviewFinding[]} findings
 * @returns {string}
 */
export function summarizeReviewFindings(findings) {
  if (!findings.length) return '';
  return findings.map((item, index) => {
    const line = item.line != null ? `:${item.line}` : '';
    return `${index + 1}. [${item.severity}] ${item.path}${line} — ${item.note.trim()}`;
  }).join('\n');
}

/**
 * @param {string} baseReason
 * @param {PlanAnnotation[]} annotations
 * @param {ReviewFinding[]} [findings]
 * @returns {string}
 */
export function composeOperatorReason(baseReason, annotations, findings = []) {
  const parts = [];
  const base = baseReason.trim();
  if (base) parts.push(base);
  const planSummary = summarizePlanAnnotations(annotations);
  if (planSummary) parts.push(`Plan annotations:\n${planSummary}`);
  const findingSummary = summarizeReviewFindings(findings);
  if (findingSummary) parts.push(`Review findings:\n${findingSummary}`);
  return parts.join('\n\n') || 'operator review';
}

/**
 * @param {Partial<PlanAnnotation> & { stepIndex: number, kind: PlanAnnotation['kind'], text: string }} input
 * @returns {PlanAnnotation}
 */
export function createPlanAnnotation(input) {
  return {
    id: input.id ?? `ann-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
    stepIndex: input.stepIndex,
    kind: input.kind,
    text: input.text,
  };
}

/**
 * @param {Partial<ReviewFinding> & { path: string, note: string, severity: ReviewFinding['severity'] }} input
 * @returns {ReviewFinding}
 */
export function createReviewFinding(input) {
  return {
    id: input.id ?? `find-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
    path: input.path,
    line: input.line ?? null,
    side: input.side ?? 'both',
    severity: input.severity,
    note: input.note,
  };
}
