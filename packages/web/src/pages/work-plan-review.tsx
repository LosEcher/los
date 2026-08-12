import type { RunContractDraft } from '../api/index.js';
import { formatDate } from '../ui.js';
import { useI18n } from '../i18n';
import {
  PlanAnnotator,
  type PlanAnnotation,
} from '../plan-annotate-ui.js';

export function PlanReview({
  contract,
  debugMode,
  annotations,
  onAnnotationsChange,
  annotateEnabled,
}: {
  contract?: RunContractDraft;
  debugMode: boolean;
  annotations: PlanAnnotation[];
  onAnnotationsChange: (next: PlanAnnotation[]) => void;
  annotateEnabled: boolean;
}) {
  const { t } = useI18n();
  const plan = contract?.plan ?? [];
  const verifications = contract?.verifications ?? [];
  return (
    <section className="contract-section plan-review">
      <div className="contract-section-heading">
        <h3>{t('work.plan.title')}</h3>
        <span>
          {contract?.planRevision
            ? t('work.plan.revision', { n: contract.planRevision })
            : t('work.plan.draft')}
        </span>
      </div>
      {annotateEnabled ? (
        <>
          <p className="plan-annotate-hint">{t('work.plan.annotateHint')}</p>
          <PlanAnnotator
            plan={plan}
            annotations={annotations}
            onChange={onAnnotationsChange}
            debugMode={debugMode}
          />
        </>
      ) : plan.length === 0 ? (
        <p>{t('work.plan.none')}</p>
      ) : (
        <ol className="plan-step-list">
          {plan.map((step, index) => (
            <li key={`${step.id ?? 'step'}-${index}`} className="plan-step">
              <div className="plan-step-title">
                <strong>
                  {step.title ?? step.id ?? t('work.plan.stepFallback', { n: index + 1 })}
                </strong>
                {debugMode ? <span>{step.id ?? `step-${index + 1}`}</span> : null}
              </div>
              <p>{step.description ?? t('work.plan.noDescription')}</p>
              <dl className="plan-step-facts">
                <div>
                  <dt>{t('work.plan.dependsOn')}</dt>
                  <dd>
                    {step.dependsOnIds?.length
                      ? step.dependsOnIds.join(', ')
                      : t('common.none')}
                  </dd>
                </div>
                <div>
                  <dt>{t('work.plan.writableScope')}</dt>
                  <dd>
                    {step.editableSurfaces?.length
                      ? step.editableSurfaces.join(', ')
                      : t('work.plan.noScopeDeclared')}
                  </dd>
                </div>
                <div>
                  <dt>{t('work.plan.doneWhen')}</dt>
                  <dd>{step.completionCriteria ?? t('work.plan.noCriterion')}</dd>
                </div>
              </dl>
            </li>
          ))}
        </ol>
      )}
      <div className="plan-verification-block">
        <h4>{t('work.plan.verificationMapping')}</h4>
        {verifications.length === 0 ? (
          <p>{t('work.plan.noMapping')}</p>
        ) : (
          <ul>
            {verifications.map(requirement => (
              <li key={requirement.id}>
                <strong>{requirement.id}</strong>
                <span>{requirement.description}</span>
                {requirement.command ? <code>{requirement.command}</code> : null}
              </li>
            ))}
          </ul>
        )}
      </div>
      {contract?.planHistory?.length ? (
        <div className="plan-history">
          <h4>{t('work.plan.revisionHistory')}</h4>
          <ol>
            {contract.planHistory.map(snapshot => (
              <li key={snapshot.revision}>
                <strong>{t('work.plan.revision', { n: snapshot.revision })}</strong>
                <span>{snapshot.reason ?? t('work.plan.superseded')}</span>
                <time>{formatDate(snapshot.supersededAt)}</time>
              </li>
            ))}
          </ol>
        </div>
      ) : null}
    </section>
  );
}
