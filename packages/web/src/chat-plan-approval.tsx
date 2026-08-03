import { useEffect, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Check } from 'lucide-react';

import { getJson, postJson, type WorkItemProjection } from './api/index.js';
import { useI18n } from './i18n';

type PlanApproval = {
  runSpecId: string;
  planRevision: number;
  contractHash: string;
  label: string;
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

  useEffect(() => {
    setPlanApproval(null);
    if (running || !workItemId) return;

    let active = true;
    getJson<WorkItemProjection>(`/work-items/${workItemId}`)
      .then((workItem) => {
        const action = workItem.availableActions.approvePlan;
        if (!active || !action) return;
        setPlanApproval({ ...action.payload, label: action.label });
      })
      .catch(() => setPlanApproval(null));
    return () => { active = false; };
  }, [running, workItemId]);

  const approvePlan = useMutation({
    mutationFn: async () => {
      if (!planApproval) throw new Error('Plan approval is unavailable');
      return await postJson(`/runs/${planApproval.runSpecId}/approve`, {
        planRevision: planApproval.planRevision,
        contractHash: planApproval.contractHash,
        reason: `Approved from Chat: ${planApproval.label}`,
      });
    },
    onSuccess: () => setPlanApproval(null),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ['inbox'] });
      void queryClient.invalidateQueries({ queryKey: ['work-items'] });
      if (workItemId) void queryClient.invalidateQueries({ queryKey: ['work-item', workItemId] });
    },
  });

  if (!planApproval) return null;

  return (
    <div className="approval-strip plan-approval-strip">
      <div className="approval-card plan-ready">
        <div className="approval-card-head">
          <Check size={13} />
          <strong>{t('chat.plan.ready')}</strong>
          <span className="approval-verdict">{planApproval.label}</span>
        </div>
        <p className="approval-reason">
          {t('chat.plan.bodyBefore')}{' '}
          <a href="#work" style={{ textDecoration: 'underline' }}>{t('nav.work')}</a>{' '}
          {t('chat.plan.bodyAfter')}
        </p>
        <div className="approval-actions" style={{ display: 'flex', gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
          <button type="button" className="tiny-btn primary" disabled={approvePlan.isPending} onClick={() => approvePlan.mutate()}>
            <Check size={12} /> {approvePlan.isPending ? t('chat.plan.approving') : t('chat.plan.approveExecute')}
          </button>
          <button type="button" className="tiny-btn" onClick={() => setPlanApproval(null)}>{t('chat.plan.dismiss')}</button>
        </div>
        {approvePlan.isError ? <p className="approval-reason error">{t('chat.plan.failed', { error: String(approvePlan.error) })}</p> : null}
      </div>
    </div>
  );
}
