import { useEffect, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Check, RefreshCcw } from 'lucide-react';

import { getJson, postJson, type WorkItemProjection } from './api/index.js';
import {
  PlanAnnotator,
  buildApproveReason,
  buildRevisePayload,
  type PlanAnnotation,
} from './plan-annotate-ui.js';
import type { PlanStepDraft } from './api/types-work-items.js';
import { useI18n } from './i18n';

type PlanApproval = {
  runSpecId: string;
  planRevision: number;
  contractHash: string;
  label: string;
  plan: PlanStepDraft[];
};

export function ChatPlanApproval({
  running,
  workItemId,
}: {
  running: boolean;
  workItemId?: string;
}) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const [planApproval, setPlanApproval] = useState<PlanApproval | null>(null);
  const [notes, setNotes] = useState('');
  const [annotations, setAnnotations] = useState<PlanAnnotation[]>([]);

  useEffect(() => {
    setPlanApproval(null);
    setNotes('');
    setAnnotations([]);
    if (running || !workItemId) return;

    let active = true;
    getJson<WorkItemProjection>(`/work-items/${workItemId}`)
      .then((workItem) => {
        const action = workItem.availableActions.approvePlan;
        if (!active || !action) return;
        const plan = workItem.runContractDraft?.plan ?? [];
        setPlanApproval({ ...action.payload, label: action.label, plan });
      })
      .catch(() => setPlanApproval(null));
    return () => { active = false; };
  }, [running, workItemId]);

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['inbox'] });
    void queryClient.invalidateQueries({ queryKey: ['work-items'] });
    if (workItemId) void queryClient.invalidateQueries({ queryKey: ['work-item', workItemId] });
  };

  const approvePlan = useMutation({
    mutationFn: async () => {
      if (!planApproval) throw new Error('Plan approval is unavailable');
      return await postJson(`/runs/${planApproval.runSpecId}/approve`, {
        planRevision: planApproval.planRevision,
        contractHash: planApproval.contractHash,
        reason: buildApproveReason(
          notes.trim() || `Approved from Chat: ${planApproval.label}`,
          annotations,
        ),
      });
    },
    onSuccess: () => setPlanApproval(null),
    onSettled: invalidate,
  });

  const revisePlan = useMutation({
    mutationFn: async () => {
      if (!planApproval) throw new Error('Plan revision is unavailable');
      const payload = buildRevisePayload(
        planApproval.plan,
        annotations,
        notes.trim() || `Revision requested from Chat: ${planApproval.label}`,
      );
      return await postJson(`/runs/${planApproval.runSpecId}/revise-plan`, payload);
    },
    onSuccess: () => setPlanApproval(null),
    onSettled: invalidate,
  });

  if (!planApproval) return null;

  const busy = approvePlan.isPending || revisePlan.isPending;

  return (
    <div className="approval-strip plan-approval-strip">
      <div className="approval-card plan-ready hitl-card">
        <div className="approval-card-head hitl-card-head">
          <Check size={13} />
          <strong>{t('chat.plan.ready')}</strong>
          <span className="approval-verdict">{planApproval.label}</span>
        </div>
        <p className="approval-reason hitl-card-body">
          {t('chat.plan.bodyBefore')}{' '}
          <a href="#work" style={{ textDecoration: 'underline' }}>{t('nav.work')}</a>{' '}
          {t('chat.plan.bodyAfter')}
        </p>
        {planApproval.plan.length > 0 ? (
          <PlanAnnotator
            plan={planApproval.plan}
            annotations={annotations}
            onChange={setAnnotations}
          />
        ) : null}
        <label className="plan-annotate-notes">
          <span>{t('chat.plan.notesLabel')}</span>
          <textarea
            value={notes}
            onChange={event => setNotes(event.target.value)}
            rows={2}
            placeholder={t('chat.plan.notesPlaceholder')}
          />
        </label>
        <div className="hitl-card-options approval-actions">
          <button
            type="button"
            className="hitl-option hitl-option-primary"
            disabled={busy}
            onClick={() => approvePlan.mutate()}
          >
            <Check size={12} /> {approvePlan.isPending ? t('chat.plan.approving') : t('chat.plan.approveExecute')}
          </button>
          <button
            type="button"
            className="hitl-option hitl-option-danger"
            disabled={busy || annotations.length === 0}
            onClick={() => revisePlan.mutate()}
            title={annotations.length === 0 ? t('chat.plan.reviseNeedsAnnotation') : undefined}
          >
            <RefreshCcw size={12} /> {revisePlan.isPending ? t('chat.plan.revising') : t('chat.plan.reviseWithNotes')}
          </button>
          <button type="button" className="hitl-option" disabled={busy} onClick={() => setPlanApproval(null)}>
            {t('chat.plan.dismiss')}
          </button>
        </div>
        {approvePlan.isError ? (
          <p className="approval-reason error">{t('chat.plan.failed', { error: String(approvePlan.error) })}</p>
        ) : null}
        {revisePlan.isError ? (
          <p className="approval-reason error">{t('chat.plan.reviseFailed', { error: String(revisePlan.error) })}</p>
        ) : null}
      </div>
    </div>
  );
}
