import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Activity, ArrowDownCircle, ArrowUpCircle } from 'lucide-react';
import { getJson, postJson, type ServiceInstance } from './api';
import { DataTable, EmptyText, Fact, formatDate, StatusPill } from './ui';

export function ServicesPage() {
  const queryClient = useQueryClient();
  const [selectedId, setSelectedId] = useState<string | null>(null);

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
              <h2>Services</h2>
              <p>Mesh service instances with health, readiness, and rollout state.</p>
            </div>
          </div>
          <StatusPill status="live" />
        </div>
        <DataTable
          loading={services.isLoading}
          empty="No service instances registered."
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
              <span>{service.readiness.ready ? 'ready' : 'not ready'}</span>
              <span>{formatDate(service.lastHeartbeatAt)}</span>
            </button>
          )}
        />
      </div>

      <aside className="panel inspector">
        {selected ? (
          <>
            <div className="panel-head compact">
              <h2>Service Detail</h2>
              <span className="mono-chip">{selected.serviceKind}</span>
            </div>
            <div className="fact-list compact-facts">
              <Fact label="id" value={selected.serviceId} />
              <Fact label="kind" value={selected.serviceKind} />
              <Fact label="host" value={selected.hostLabel} />
              <Fact label="status" value={selected.status} />
              <Fact label="role" value={selected.role} />
              <Fact label="version" value={selected.version ?? 'unknown'} />
              <Fact label="bind url" value={selected.bindUrl ?? 'none'} />
              <Fact label="public url" value={selected.publicUrl ?? 'none'} />
              <Fact label="rollout" value={`${selected.rolloutState ?? 'idle'}${selected.rolloutMessage ? ` · ${selected.rolloutMessage}` : ''}`} />
              <Fact label="priority" value={String(selected.priority)} />
              <Fact label="last heartbeat" value={formatDate(selected.lastHeartbeatAt)} />
              <Fact label="ready" value={String(selected.readiness.ready)} />
            </div>
            {selected.readiness.blockers.length > 0 ? (
              <div className="definition-list">
                {selected.readiness.blockers.map((b, i) => (
                  <div className="definition" key={i}><strong>blocker</strong><span>{b}</span></div>
                ))}
              </div>
            ) : null}
            {selected.readiness.warnings.length > 0 ? (
              <div className="definition-list">
                {selected.readiness.warnings.map((w, i) => (
                  <div className="definition" key={i}><strong>warning</strong><span>{w}</span></div>
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
                <ArrowDownCircle size={14} /> drain
              </button>
              <button
                className="ghost-btn"
                type="button"
                disabled={promote.isPending || selected.status === 'online'}
                onClick={() => promote.mutate(selected.serviceId)}
              >
                <ArrowUpCircle size={14} /> promote
              </button>
            </div>
            {selected.capabilities && Object.keys(selected.capabilities).length > 0 ? (
              <div className="json-block">
                <strong>capabilities</strong>
                <pre>{JSON.stringify(selected.capabilities, null, 2)}</pre>
              </div>
            ) : null}
            {selected.health && Object.keys(selected.health).length > 0 ? (
              <div className="json-block">
                <strong>health</strong>
                <pre>{JSON.stringify(selected.health, null, 2)}</pre>
              </div>
            ) : null}
            {selected.load && Object.keys(selected.load).length > 0 ? (
              <div className="json-block">
                <strong>load</strong>
                <pre>{JSON.stringify(selected.load, null, 2)}</pre>
              </div>
            ) : null}
          </>
        ) : (
          <EmptyText text="Select a service to inspect readiness and lifecycle state." />
        )}
      </aside>
    </section>
  );
}
