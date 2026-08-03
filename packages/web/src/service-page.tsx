import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Activity, ArrowDownCircle, ArrowUpCircle } from 'lucide-react';
import { getJson, postJson, type ServiceInstance } from './api';
import { DataTable, EmptyText, Fact, formatDate, StatusPill } from './ui';
import { useI18n } from './i18n';

export function ServicesPage() {
  const queryClient = useQueryClient();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const { t } = useI18n();

  const services = useQuery({
    queryKey: ['services'],
    queryFn: () => getJson<ServiceInstance[]>('/services'),
    refetchInterval: 10_000,
  });

  const list = services.data ?? [];
  const selected = list.find(s => s.serviceId === selectedId) ?? null;

  const drain = useMutation({
    mutationFn: (id: string) => postJson(`/services/${id}/drain`, { reason: 'drain_from_console' }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['services'] }),
  });

  const promote = useMutation({
    mutationFn: (id: string) => postJson(`/services/${id}/promote`, { reason: 'promote_from_console' }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['services'] }),
  });

  return (
    <section className="panel-grid detail-grid">
      <div className="panel">
        <div className="panel-head">
          <div className="title-row">
            <Activity size={18} />
            <div>
              <h2>{t('assets.service.title')}</h2>
              <p>{t('assets.service.subtitle')}</p>
            </div>
          </div>
          <StatusPill status="live" />
        </div>
        <DataTable
          loading={services.isLoading}
          empty={t('assets.service.emptyList')}
          rows={list}
          renderRow={service => (
            <button
              type="button"
              className="record-row"
              data-active={selected?.serviceId === service.serviceId}
              onClick={() => setSelectedId(service.serviceId)}
            >
              <span className="row-title">{service.serviceId}</span>
              <span>{service.serviceKind}</span>
              <span className={`status-text ${service.status}`}>{service.status}</span>
              <span>{service.role}</span>
              <span>{service.rolloutState ?? 'idle'}</span>
              <span>{service.readiness.ready ? t('assets.label.ready') : t('assets.service.notReady')}</span>
              <span>{formatDate(service.lastHeartbeatAt)}</span>
            </button>
          )}
        />
        {list.length === 0 && !services.isLoading ? (
          <div className="empty-guide">
            <p>{t('assets.service.emptyGuidePre')} <code>pnpm start</code> {t('assets.service.emptyGuidePost')}</p>
          </div>
        ) : null}
      </div>

      <aside className="panel inspector">
        {selected ? (
          <>
            <div className="panel-head compact">
              <h2>{t('assets.service.detailTitle')}</h2>
              <span className="mono-chip">{selected.serviceKind}</span>
            </div>
            <div className="fact-list compact-facts">
              <Fact label={t('assets.label.id')} value={selected.serviceId} />
              <Fact label={t('assets.label.kind')} value={selected.serviceKind} />
              <Fact label={t('assets.label.host')} value={selected.hostLabel} />
              <Fact label={t('assets.label.status')} value={selected.status} />
              <Fact label={t('assets.label.role')} value={selected.role} />
              <Fact label={t('assets.label.version')} value={selected.version ?? t('common.unknown')} />
              <Fact label={t('assets.label.bindUrl')} value={selected.bindUrl ?? t('common.none')} />
              <Fact label={t('assets.label.publicUrl')} value={selected.publicUrl ?? t('common.none')} />
              <Fact label={t('assets.label.rollout')} value={`${selected.rolloutState ?? 'idle'}${selected.rolloutMessage ? ` ${t('assets.service.rolloutMessageSuffix', { message: selected.rolloutMessage })}` : ''}`} />
              <Fact label={t('assets.label.priority')} value={String(selected.priority)} />
              <Fact label={t('assets.label.lastHeartbeat')} value={formatDate(selected.lastHeartbeatAt)} />
              <Fact label={t('assets.label.ready')} value={String(selected.readiness.ready)} />
            </div>
            {selected.readiness.blockers.length > 0 ? (
              <div className="definition-list">
                {selected.readiness.blockers.map((b, i) => (
                  <div className="definition" key={i}><strong>{t('assets.service.blocker')}</strong><span>{b}</span></div>
                ))}
              </div>
            ) : null}
            {selected.readiness.warnings.length > 0 ? (
              <div className="definition-list">
                {selected.readiness.warnings.map((w, i) => (
                  <div className="definition" key={i}><strong>{t('assets.service.warning')}</strong><span>{w}</span></div>
                ))}
              </div>
            ) : null}
            <div className="inline-actions">
              <button
                className="ghost-btn"
                type="button"
                disabled={drain.isPending || selected.status === 'draining'}
                onClick={() => drain.mutate(selected.serviceId)}
              >
                <ArrowDownCircle size={14} /> {t('assets.service.drain')}
              </button>
              <button
                className="ghost-btn"
                type="button"
                disabled={promote.isPending || selected.status === 'online'}
                onClick={() => promote.mutate(selected.serviceId)}
              >
                <ArrowUpCircle size={14} /> {t('assets.service.promote')}
              </button>
            </div>
            {selected.capabilities && Object.keys(selected.capabilities).length > 0 ? (
              <div className="json-block">
                <strong>{t('assets.label.capabilities')}</strong>
                <pre>{JSON.stringify(selected.capabilities, null, 2)}</pre>
              </div>
            ) : null}
            {selected.health && Object.keys(selected.health).length > 0 ? (
              <div className="json-block">
                <strong>{t('assets.service.health')}</strong>
                <pre>{JSON.stringify(selected.health, null, 2)}</pre>
              </div>
            ) : null}
            {selected.load && Object.keys(selected.load).length > 0 ? (
              <div className="json-block">
                <strong>{t('assets.service.load')}</strong>
                <pre>{JSON.stringify(selected.load, null, 2)}</pre>
              </div>
            ) : null}
          </>
        ) : (
          <EmptyText text={t('assets.service.selectHint')} />
        )}
      </aside>
    </section>
  );
}
