import { type ReactNode } from 'react';
import { Braces } from 'lucide-react';
import {
  Definition,
  StatusPill,
} from '../ui.js';
import { useI18n } from '../i18n';

export function ReservedPage({ kind, icon, description, fields }: { kind: string; icon: ReactNode; description: string; fields: string[] }) {
  const { t } = useI18n();
  return (
    <section className="panel-grid settings-grid">
      <div className="panel">
        <div className="panel-head">
          <div className="title-row">
            {icon}
            <div>
              <h2>{kind}</h2>
              <p>{description}</p>
            </div>
          </div>
          <StatusPill status="reserved" />
        </div>
        <div className="field-grid">
          {fields.map(field => (
            <div className="field-token" key={field}>
              <Braces size={14} />
              <span>{field}</span>
            </div>
          ))}
        </div>
      </div>
      <aside className="panel inspector">
        <div className="panel-head compact"><h2>{t('ops.reserved.initialPolicyTitle')}</h2></div>
        <div className="definition-list">
          <Definition term={t('ops.reserved.phase1Term')} text={t('ops.reserved.phase1Text')} />
          <Definition term={t('ops.reserved.writeGateTerm')} text={t('ops.reserved.writeGateText')} />
          <Definition term={t('ops.reserved.auditTerm')} text={t('ops.reserved.auditText')} />
        </div>
      </aside>
    </section>
  );
}
