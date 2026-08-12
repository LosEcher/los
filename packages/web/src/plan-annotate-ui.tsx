/**
 * Interactive plan annotation + review findings list (Plannotator-class UI).
 */
import { useMemo, useState } from 'react';
import { MessageSquarePlus, StickyNote, Trash2 } from 'lucide-react';
import type { PlanStepDraft } from './api/types-work-items.js';
import {
  applyPlanAnnotations,
  composeOperatorReason,
  createPlanAnnotation,
  createReviewFinding,
} from './plan-annotate.mjs';
import type { PlanAnnotation, ReviewFinding } from './plan-annotate.mjs';
import { useI18n } from './i18n';

export type { PlanAnnotation, ReviewFinding };

export function PlanAnnotator({
  plan,
  annotations,
  onChange,
  debugMode,
}: {
  plan: PlanStepDraft[];
  annotations: PlanAnnotation[];
  onChange: (next: PlanAnnotation[]) => void;
  debugMode?: boolean;
}) {
  const { t } = useI18n();
  const [draftByStep, setDraftByStep] = useState<Record<number, string>>({});
  const [kindByStep, setKindByStep] = useState<Record<number, PlanAnnotation['kind']>>({});

  if (plan.length === 0) {
    return <p className="plan-annotate-empty">{t('work.plan.none')}</p>;
  }

  function addAnnotation(stepIndex: number) {
    const text = (draftByStep[stepIndex] ?? '').trim();
    if (!text) return;
    const kind = kindByStep[stepIndex] ?? 'note';
    onChange([...annotations, createPlanAnnotation({ stepIndex, kind, text })]);
    setDraftByStep(current => ({ ...current, [stepIndex]: '' }));
  }

  function removeAnnotation(id: string) {
    onChange(annotations.filter(item => item.id !== id));
  }

  return (
    <ol className="plan-step-list plan-annotate-list">
      {plan.map((step, index) => {
        const stepNotes = annotations.filter(item => item.stepIndex === index);
        return (
          <li key={`${step.id ?? 'step'}-${index}`} className="plan-step plan-step-annotate">
            <div className="plan-step-title">
              <strong>{step.title ?? step.id ?? t('work.plan.stepFallback', { n: index + 1 })}</strong>
              {debugMode ? <span>{step.id ?? `step-${index + 1}`}</span> : null}
            </div>
            <p>{step.description ?? t('work.plan.noDescription')}</p>
            {stepNotes.length > 0 ? (
              <ul className="plan-annotation-list">
                {stepNotes.map(note => (
                  <li key={note.id} className="plan-annotation-item" data-kind={note.kind}>
                    <StickyNote size={12} aria-hidden />
                    <span className="plan-annotation-kind">{note.kind}</span>
                    <span className="plan-annotation-text">{note.text}</span>
                    <button
                      type="button"
                      className="ghost-btn tiny-btn"
                      aria-label={t('work.plan.removeAnnotation')}
                      onClick={() => removeAnnotation(note.id)}
                    >
                      <Trash2 size={12} />
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
            <div className="plan-annotate-composer">
              <select
                aria-label={t('work.plan.annotationKind')}
                value={kindByStep[index] ?? 'note'}
                onChange={event => setKindByStep(current => ({
                  ...current,
                  [index]: event.target.value as PlanAnnotation['kind'],
                }))}
              >
                <option value="note">{t('work.plan.kindNote')}</option>
                <option value="replace_title">{t('work.plan.kindReplaceTitle')}</option>
                <option value="replace_description">{t('work.plan.kindReplaceDescription')}</option>
              </select>
              <input
                value={draftByStep[index] ?? ''}
                onChange={event => setDraftByStep(current => ({ ...current, [index]: event.target.value }))}
                placeholder={t('work.plan.annotationPlaceholder')}
                onKeyDown={event => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    addAnnotation(index);
                  }
                }}
              />
              <button type="button" className="tiny-btn" onClick={() => addAnnotation(index)}>
                <MessageSquarePlus size={12} /> {t('work.plan.addAnnotation')}
              </button>
            </div>
          </li>
        );
      })}
    </ol>
  );
}

export function ReviewFindingsList({
  findings,
  onRemove,
}: {
  findings: ReviewFinding[];
  onRemove?: (id: string) => void;
}) {
  const { t } = useI18n();
  if (findings.length === 0) {
    return <p className="review-findings-empty">{t('work.review.noFindings')}</p>;
  }
  return (
    <ul className="review-findings-list">
      {findings.map(item => (
        <li key={item.id} className="review-finding" data-severity={item.severity}>
          <span className="review-finding-severity">{item.severity}</span>
          <code>{item.path}{item.line != null ? `:${item.line}` : ''}</code>
          <span>{item.note}</span>
          {onRemove ? (
            <button type="button" className="ghost-btn tiny-btn" onClick={() => onRemove(item.id)}>
              <Trash2 size={12} />
            </button>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

export function usePlanAnnotationState(initialPlan: PlanStepDraft[] = []) {
  const [annotations, setAnnotations] = useState<PlanAnnotation[]>([]);
  const revisedPlan = useMemo(
    () => applyPlanAnnotations(initialPlan, annotations),
    [initialPlan, annotations],
  );
  return { annotations, setAnnotations, revisedPlan };
}

export function buildApproveReason(base: string, annotations: PlanAnnotation[]): string {
  return composeOperatorReason(base, annotations, []);
}

export function buildRevisePayload(plan: PlanStepDraft[], annotations: PlanAnnotation[], baseReason: string) {
  const revisedPlan = applyPlanAnnotations(plan, annotations);
  return {
    plan: revisedPlan,
    reason: composeOperatorReason(baseReason || 'operator requested plan revision', annotations, []),
  };
}

export { createReviewFinding, composeOperatorReason, applyPlanAnnotations };
