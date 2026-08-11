/**
 * Fleet board card — status · candidate · mem% · findings from
 * GET /ops/runtime-health (P3 operator UX).
 */
import { useQuery } from '@tanstack/react-query';
import { Server } from 'lucide-react';

import { getJson } from './api/index.js';
import { Badge, formatDate, RefreshQueryButton, StatusPill } from './ui.js';
import { useI18n } from './i18n';

export type RuntimeHealthFleetResponse = {
  overall: 'ok' | 'degraded' | 'critical';
  warnings: string[];
  fleet: {
    namedIds: string[];
    healthy: number;
    offline: string[];
    onlineUnverified: string[];
    missing: string[];
    attentionNodeIds: string[];
  };
  fleetResources?: {
    assessedAt: string;
    warningCount: number;
    criticalCount: number;
    nodes: Array<{
      nodeId: string;
      status?: string;
      candidate?: boolean;
      lastHeartbeatAt?: string;
      memoryAvailableRatio?: number;
      swapUsedRatio?: number;
      activeTaskCount?: number;
      lightNode?: boolean;
      findings: Array<{ code: string; severity: string; message: string }>;
    }>;
  };
};

function pct(ratio: number | undefined): string {
  if (ratio === undefined || !Number.isFinite(ratio)) return '—';
  return `${Math.round(ratio * 100)}%`;
}

function memTone(ratio: number | undefined): 'ok' | 'warn' | 'err' {
  if (ratio === undefined || !Number.isFinite(ratio)) return 'ok';
  if (ratio < 0.05) return 'err';
  if (ratio < 0.15) return 'warn';
  return 'ok';
}

function swapTone(ratio: number | undefined): 'ok' | 'warn' | 'err' {
  if (ratio === undefined || !Number.isFinite(ratio)) return 'ok';
  if (ratio > 0.8) return 'err';
  if (ratio > 0.5) return 'warn';
  return 'ok';
}

function overallTone(overall: string): 'ok' | 'warn' | 'err' {
  if (overall === 'critical') return 'err';
  if (overall === 'degraded') return 'warn';
  return 'ok';
}

export function FleetCard({ compact = false }: { compact?: boolean }) {
  const { t } = useI18n();
  const query = useQuery({
    queryKey: ['ops-runtime-health'],
    queryFn: () => getJson<RuntimeHealthFleetResponse>('/ops/runtime-health'),
    refetchInterval: 15_000,
  });

  if (query.isLoading) {
    return (
      <section className={`fleet-card${compact ? ' fleet-card-compact' : ''}`} aria-busy="true">
        <div className="fleet-card-head">
          <Server size={16} />
          <strong>{t('ops.fleet.cardTitle')}</strong>
        </div>
        <p className="usage-note">{t('ops.fleet.loading')}</p>
      </section>
    );
  }

  if (query.error || !query.data) {
    return (
      <section className={`fleet-card${compact ? ' fleet-card-compact' : ''}`}>
        <div className="fleet-card-head">
          <Server size={16} />
          <strong>{t('ops.fleet.cardTitle')}</strong>
        </div>
        <p className="daily-error">
          {t('ops.fleet.unavailable', { error: String(query.error ?? 'empty') })}
        </p>
      </section>
    );
  }

  const data = query.data;
  const resources = data.fleetResources;
  const nodes = resources?.nodes ?? [];
  const attention = data.fleet.attentionNodeIds ?? [];
  const resourceWarnings = data.warnings.filter((w) => w.startsWith('resource:') || w.startsWith('fleet:'));

  return (
    <section className={`fleet-card${compact ? ' fleet-card-compact' : ''}`} aria-live="polite">
      <div className="fleet-card-head">
        <div className="title-row">
          <Server size={16} />
          <div>
            <strong>{t('ops.fleet.cardTitle')}</strong>
            <p className="usage-note">
              {t('ops.fleet.summary', {
                healthy: data.fleet.healthy,
                named: data.fleet.namedIds.length,
                overall: data.overall,
              })}
            </p>
          </div>
        </div>
        <div className="toolbar">
          <Badge tone={overallTone(data.overall)}>{data.overall}</Badge>
          <StatusPill status="live" />
          <RefreshQueryButton queryKey={['ops-runtime-health']} />
        </div>
      </div>

      {attention.length > 0 ? (
        <p className="fleet-card-attention">
          {t('ops.fleet.attention', { nodes: attention.join(', ') })}
        </p>
      ) : null}

      {resourceWarnings.length > 0 && !compact ? (
        <ul className="fleet-card-warnings usage-note">
          {resourceWarnings.slice(0, 6).map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      ) : null}

      {nodes.length === 0 ? (
        <p className="usage-note">{t('ops.fleet.empty')}</p>
      ) : (
        <div className="fleet-card-grid">
          {nodes.map((node) => {
            const findingCodes = (node.findings ?? []).map((f) => f.code);
            return (
              <article
                key={node.nodeId}
                className="fleet-card-node"
                data-status={node.status ?? 'unknown'}
                data-candidate={node.candidate === true ? 'true' : 'false'}
              >
                <header>
                  <span className="row-title">{node.nodeId}</span>
                  {node.lightNode ? <Badge tone="warn">{t('ops.fleet.light')}</Badge> : null}
                </header>
                <dl>
                  <div>
                    <dt>{t('ops.fleet.colStatus')}</dt>
                    <dd className={`status-text ${node.status ?? ''}`}>{node.status ?? '—'}</dd>
                  </div>
                  <div>
                    <dt>{t('ops.fleet.colCandidate')}</dt>
                    <dd>
                      {node.candidate
                        ? t('ops.fleet.candYes')
                        : t('ops.fleet.candNo')}
                    </dd>
                  </div>
                  <div>
                    <dt>{t('ops.fleet.colMem')}</dt>
                    <dd>
                      <Badge tone={memTone(node.memoryAvailableRatio)}>
                        {pct(node.memoryAvailableRatio)}
                      </Badge>
                    </dd>
                  </div>
                  <div>
                    <dt>{t('ops.fleet.colSwap')}</dt>
                    <dd>
                      <Badge tone={swapTone(node.swapUsedRatio)}>
                        {pct(node.swapUsedRatio)}
                      </Badge>
                    </dd>
                  </div>
                  {!compact ? (
                    <div>
                      <dt>{t('ops.fleet.colTasks')}</dt>
                      <dd>{node.activeTaskCount ?? 0}</dd>
                    </div>
                  ) : null}
                  <div>
                    <dt>{t('ops.fleet.colHeartbeat')}</dt>
                    <dd>{node.lastHeartbeatAt ? formatDate(node.lastHeartbeatAt) : '—'}</dd>
                  </div>
                </dl>
                {findingCodes.length > 0 ? (
                  <p className="fleet-card-findings">
                    {findingCodes.slice(0, 3).join(', ')}
                  </p>
                ) : null}
              </article>
            );
          })}
        </div>
      )}

      {resources?.assessedAt && !compact ? (
        <p className="usage-note fleet-card-foot">
          {t('ops.fleet.assessedAt', { at: formatDate(resources.assessedAt) })}
          {resources.warningCount > 0 || resources.criticalCount > 0
            ? ` · ${t('ops.fleet.findingCounts', {
              warn: resources.warningCount,
              crit: resources.criticalCount,
            })}`
            : ''}
        </p>
      ) : null}
    </section>
  );
}
