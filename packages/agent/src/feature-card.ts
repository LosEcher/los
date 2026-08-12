/**
 * FeatureCard handoff + rework identity policy (pi-subagents / scout pattern).
 * Pure helpers — graph scheduler and gateway adapt around these rules.
 */

export type FeatureCardFile = {
  path: string;
  lineRange?: string;
  note?: string;
};

export type FeatureCard = {
  goal: string;
  acceptance: string[];
  editableSurfaces: string[];
  files?: FeatureCardFile[];
  keySymbols?: string[];
  constraints?: string[];
  outOfScope?: string[];
  verificationHints?: string[];
  parentWorkItemId?: string;
  parentRunSpecId?: string;
  laneId?: string;
};

export type ReviewFinding = {
  path: string;
  line?: number | null;
  severity: 'critical' | 'warning' | 'suggestion';
  note: string;
  sourceAttemptId?: string;
};

export type AttemptIdentity = {
  attemptId: string;
  taskRunId?: string;
  sessionId?: string;
  role: 'worker' | 'reviewer' | 'coordinator' | string;
  writerAttemptId?: string;
};

export type ReworkDecision =
  | { ok: true; reason: 'fresh_worker' }
  | { ok: false; reason: 'same_writer_attempt' | 'same_writer_session' | 'same_task_run' | 'missing_identity' };

export function validateFeatureCard(card: FeatureCard): string[] {
  const errors: string[] = [];
  if (!card.goal?.trim()) errors.push('goal is required');
  if (!Array.isArray(card.acceptance) || card.acceptance.length === 0) {
    errors.push('acceptance must be a non-empty array');
  }
  if (!Array.isArray(card.editableSurfaces) || card.editableSurfaces.length === 0) {
    errors.push('editableSurfaces must be a non-empty array');
  }
  return errors;
}

/** Parent run surfaces must contain every worker surface when parent is declared. */
export function _assertSurfacesWithinParent(
  card: FeatureCard,
  parentSurfaces: string[] | undefined,
): string[] {
  if (!parentSurfaces || parentSurfaces.length === 0) return [];
  const parent = new Set(parentSurfaces);
  return card.editableSurfaces.filter(surface => !parent.has(surface));
}

/**
 * Hard rule: rework after reject must not resume the writer attempt/session/run.
 * A fresh worker attempt is required.
 */
export function canDispatchReworkWorker(
  rejectedWriter: AttemptIdentity | undefined,
  candidate: AttemptIdentity | undefined,
): ReworkDecision {
  if (!rejectedWriter || !candidate) {
    return { ok: false, reason: 'missing_identity' };
  }
  if (candidate.attemptId === rejectedWriter.attemptId) {
    return { ok: false, reason: 'same_writer_attempt' };
  }
  if (
    rejectedWriter.sessionId
    && candidate.sessionId
    && candidate.sessionId === rejectedWriter.sessionId
  ) {
    return { ok: false, reason: 'same_writer_session' };
  }
  if (
    rejectedWriter.taskRunId
    && candidate.taskRunId
    && candidate.taskRunId === rejectedWriter.taskRunId
  ) {
    return { ok: false, reason: 'same_task_run' };
  }
  return { ok: true, reason: 'fresh_worker' };
}

/** Compact worker prompt block — only the card, no coordinator vision dump. */
export function formatFeatureCardForWorker(card: FeatureCard): string {
  const lines = [
    '# Feature card',
    '',
    `## Goal`,
    card.goal.trim(),
    '',
    '## Acceptance',
    ...card.acceptance.map(item => `- ${item}`),
    '',
    '## Editable surfaces',
    ...card.editableSurfaces.map(item => `- ${item}`),
  ];
  if (card.files?.length) {
    lines.push('', '## Files');
    for (const file of card.files) {
      const range = file.lineRange ? ` (${file.lineRange})` : '';
      const note = file.note ? ` — ${file.note}` : '';
      lines.push(`- \`${file.path}\`${range}${note}`);
    }
  }
  if (card.keySymbols?.length) {
    lines.push('', '## Key symbols', ...card.keySymbols.map(item => `- ${item}`));
  }
  if (card.constraints?.length) {
    lines.push('', '## Constraints', ...card.constraints.map(item => `- ${item}`));
  }
  if (card.outOfScope?.length) {
    lines.push('', '## Out of scope', ...card.outOfScope.map(item => `- ${item}`));
  }
  if (card.verificationHints?.length) {
    lines.push('', '## Verification hints', ...card.verificationHints.map(item => `- ${item}`));
  }
  return lines.join('\n');
}

/** Reviewer prompt: card + findings context, no writer chain-of-thought. */
export function formatFeatureCardForReviewer(
  card: FeatureCard,
  findings: ReviewFinding[] = [],
): string {
  const base = formatFeatureCardForWorker(card);
  if (findings.length === 0) {
    return `${base}\n\n## Reviewer role\nYou are a fresh reviewer. Use read-only tools. Do not edit files.`;
  }
  const findingLines = findings.map((item, index) => {
    const line = item.line != null ? `:${item.line}` : '';
    return `${index + 1}. [${item.severity}] \`${item.path}${line}\` — ${item.note}`;
  });
  return [
    base,
    '',
    '## Prior findings',
    ...findingLines,
    '',
    '## Reviewer role',
    'You are a fresh reviewer. Use read-only tools. Do not edit files.',
  ].join('\n');
}

export type CoordinatorWakeKind = 'worker_finished' | 'reviewer_accepted' | 'reviewer_rejected';

export function buildCoordinatorWakeEvent(input: {
  kind: CoordinatorWakeKind;
  graphId: string;
  taskId: string;
  attemptId?: string;
  findings?: ReviewFinding[];
}): Record<string, unknown> {
  return {
    type: 'operator.coordinator.wake',
    kind: input.kind,
    graphId: input.graphId,
    taskId: input.taskId,
    attemptId: input.attemptId,
    findings: input.findings ?? [],
    at: new Date().toISOString(),
  };
}
