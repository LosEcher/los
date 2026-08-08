/**
 * Phase 1 real-run observability: fingerprint, turn waterfall, failure facets.
 * Consumes GET /sessions/:id/execution-observability (read-only projection).
 */
import { useQuery } from '@tanstack/react-query';
import { Activity, AlertTriangle } from 'lucide-react';
import { getJson, type ExecutionObservabilityProjection, type ExecutionTurnWaterfall } from '../api';
import { Badge, EmptyText, Fact } from '../ui';
import { useI18n } from '../i18n';

const QUERY_KEY = 'session-execution-observability';

export function executionObservabilityQueryKey(sessionId: string | null | undefined) {
  return [QUERY_KEY, sessionId] as const;
}

export function ExecutionObservabilityPanel({
  sessionId,
  compact = false,
}: {
  sessionId: string | null | undefined;
  compact?: boolean;
}) {
  const { t } = useI18n();
  const query = useQuery({
    queryKey: executionObservabilityQueryKey(sessionId),
    queryFn: () => getJson<ExecutionObservabilityProjection>(
      `/sessions/${encodeURIComponent(sessionId!)}/execution-observability`,
    ),
    enabled: Boolean(sessionId),
    refetchInterval: compact ? 15_000 : 30_000,
  });

  if (!sessionId) return null;

  return (
    <section className={`exec-obs${compact ? ' is-compact' : ''}`} aria-label={t('assets.obs.sectionAria')}>
      <div className="exec-obs-head">
        <div className="exec-obs-title">
          <Activity size={14} />
          <strong>{t('assets.obs.title')}</strong>
        </div>
        {query.data ? (
          <Badge tone={query.data.fingerprint.status === 'known' ? 'ok' : 'muted'}>
            {query.data.fingerprint.status === 'known'
              ? t('assets.obs.fingerprintKnown')
              : t('assets.obs.fingerprintUnknown')}
          </Badge>
        ) : null}
      </div>

      {query.isLoading ? <EmptyText text={t('assets.obs.loading')} /> : null}
      {query.error ? (
        <div className="exec-obs-error" role="alert">
          {t('assets.obs.loadError', { error: readableError(query.error) })}
        </div>
      ) : null}

      {query.data ? <ObservabilityBody data={query.data} compact={compact} /> : null}
    </section>
  );
}

function ObservabilityBody({
  data,
  compact,
}: {
  data: ExecutionObservabilityProjection;
  compact: boolean;
}) {
  const { t } = useI18n();
  const totals = summarizeWaterfall(data.waterfall);
  const maxWait = Math.max(1, ...data.waterfall.map(turn => turn.modelWait.durationMs + turn.toolWait.durationMs));

  return (
    <>
      <div className="fact-list compact-facts">
        <Fact label={t('assets.obs.turns')} value={String(data.waterfall.length)} />
        <Fact label={t('assets.obs.totalTokens')} value={formatCount(totals.totalTokens)} />
        <Fact label={t('assets.obs.modelWait')} value={formatDurationMs(totals.modelWaitMs)} />
        <Fact label={t('assets.obs.toolWait')} value={formatDurationMs(totals.toolWaitMs)} />
        <Fact
          label={t('assets.obs.issues')}
          value={formatIssues(totals.retries, totals.errors, totals.denied, t)}
        />
      </div>

      <div className="exec-obs-fingerprint">
        <span className="exec-obs-kicker">{t('assets.obs.fingerprint')}</span>
        <code className="exec-obs-hash" title={data.fingerprint.hash ?? undefined}>
          {data.fingerprint.hash
            ? shortHash(data.fingerprint.hash)
            : t('assets.obs.fingerprintUnavailable')}
        </code>
        <div className="exec-obs-components">
          {(Object.keys(data.fingerprint.components) as Array<keyof typeof data.fingerprint.components>).map(key => {
            const component = data.fingerprint.components[key];
            return (
              <span
                key={key}
                className={`exec-obs-chip${component.status === 'known' ? ' is-known' : ' is-unknown'}`}
                title={component.value ?? t('assets.obs.componentUnknown')}
              >
                {t(`assets.obs.component.${key}`)}
                <em>{component.status === 'known' ? shortHash(component.value ?? '', 8) : '—'}</em>
              </span>
            );
          })}
        </div>
        {data.fingerprint.status === 'unknown' ? (
          <p className="exec-obs-hint">{t('assets.obs.fingerprintHint')}</p>
        ) : null}
      </div>

      {data.failureFacets.length > 0 ? (
        <div className="exec-obs-facets">
          <div className="exec-obs-kicker">
            <AlertTriangle size={12} /> {t('assets.obs.facetsTitle')}
          </div>
          <ul className="exec-obs-facet-list">
            {data.failureFacets.map((facet, index) => (
              <li key={`${facet.category}-${facet.code}-${index}`} className="exec-obs-facet" data-category={facet.category}>
                <Badge tone={facetTone(facet.category)}>{facet.category}</Badge>
                <strong>{facet.code}</strong>
                {facet.message ? <span>{facet.message}</span> : null}
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <p className="exec-obs-hint">{t('assets.obs.noFacets')}</p>
      )}

      {data.waterfall.length === 0 ? (
        <EmptyText text={t('assets.obs.noWaterfall')} />
      ) : (
        <div className="exec-obs-waterfall" aria-label={t('assets.obs.waterfallAria')}>
          {(compact ? data.waterfall.slice(-6) : data.waterfall).map(turn => (
            <WaterfallRow key={turn.turn} turn={turn} maxWait={maxWait} />
          ))}
          {compact && data.waterfall.length > 6 ? (
            <p className="exec-obs-hint">{t('assets.obs.waterfallTruncated', { count: data.waterfall.length - 6 })}</p>
          ) : null}
        </div>
      )}
    </>
  );
}

function WaterfallRow({ turn, maxWait }: { turn: ExecutionTurnWaterfall; maxWait: number }) {
  const { t } = useI18n();
  const modelPct = Math.max(2, Math.round((turn.modelWait.durationMs / maxWait) * 100));
  const toolPct = Math.max(turn.toolWait.durationMs > 0 ? 2 : 0, Math.round((turn.toolWait.durationMs / maxWait) * 100));
  const issueBits = [
    turn.retries.count > 0 ? t('assets.obs.retryCount', { count: turn.retries.count }) : null,
    turn.errors.count > 0 ? t('assets.obs.errorCount', { count: turn.errors.count }) : null,
    turn.denied.count > 0 ? t('assets.obs.deniedCount', { count: turn.denied.count }) : null,
  ].filter(Boolean);

  return (
    <div className="exec-obs-turn">
      <div className="exec-obs-turn-meta">
        <strong>{t('assets.obs.turn', { n: turn.turn })}</strong>
        <span>{formatDurationMs(turn.modelWait.durationMs)} / {formatDurationMs(turn.toolWait.durationMs)}</span>
        <span>{formatCount(turn.tokens.totalTokens)} tok</span>
      </div>
      <div className="exec-obs-bars" aria-hidden="true">
        <span className="exec-obs-bar is-model" style={{ width: `${modelPct}%` }} />
        <span className="exec-obs-bar is-tool" style={{ width: `${toolPct}%` }} />
      </div>
      {issueBits.length > 0 ? <div className="exec-obs-turn-issues">{issueBits.join(' · ')}</div> : null}
    </div>
  );
}

export function summarizeWaterfall(waterfall: ExecutionTurnWaterfall[]) {
  return waterfall.reduce(
    (acc, turn) => {
      acc.modelWaitMs += turn.modelWait.durationMs;
      acc.toolWaitMs += turn.toolWait.durationMs;
      acc.totalTokens += turn.tokens.totalTokens;
      acc.retries += turn.retries.count;
      acc.errors += turn.errors.count;
      acc.denied += turn.denied.count;
      return acc;
    },
    { modelWaitMs: 0, toolWaitMs: 0, totalTokens: 0, retries: 0, errors: 0, denied: 0 },
  );
}

export function formatDurationMs(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '0ms';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
  return `${(ms / 60_000).toFixed(1)}m`;
}

export function formatCount(value: number): string {
  if (!Number.isFinite(value)) return '0';
  return String(Math.round(value));
}

export function shortHash(value: string, keep = 12): string {
  if (!value) return '—';
  return value.length <= keep ? value : `${value.slice(0, keep)}…`;
}

function formatIssues(
  retries: number,
  errors: number,
  denied: number,
  t: (key: string, vars?: Record<string, string | number>) => string,
): string {
  if (retries === 0 && errors === 0 && denied === 0) return t('assets.obs.issuesNone');
  return [
    retries > 0 ? t('assets.obs.retryCount', { count: retries }) : null,
    errors > 0 ? t('assets.obs.errorCount', { count: errors }) : null,
    denied > 0 ? t('assets.obs.deniedCount', { count: denied }) : null,
  ].filter(Boolean).join(' · ');
}

function facetTone(category: string): 'ok' | 'warn' | 'err' | 'info' | 'muted' {
  if (category === 'verification' || category === 'provider') return 'warn';
  if (category === 'tool' || category === 'policy') return 'err';
  if (category === 'recovery') return 'info';
  return 'muted';
}

function readableError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
