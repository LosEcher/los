import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, RefreshCcw, Scale } from 'lucide-react';
import { getJson, postJson } from './api';
import { Badge, Button, EmptyText, Field, formatDate } from './ui';
import { useI18n } from './i18n';
import {
  ChannelChip,
  PairwiseDetail,
  readableError,
  shortId,
  verdictLabel,
  verdictTone,
  type PairwiseEval,
  type Verdict,
} from './pairwise-evals-detail';

type PairwiseEvalsPageProps = {
  onOpenRun?: (runSpecId: string) => void;
  onOpenSession?: (sessionId: string) => void;
};

export function PairwiseEvalsPage({ onOpenRun, onOpenSession }: PairwiseEvalsPageProps = {}) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const [pairId, setPairId] = useState('');
  const [experimentId, setExperimentId] = useState('');
  const [verdict, setVerdict] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showRecord, setShowRecord] = useState(false);
  const [form, setForm] = useState({
    pairId: '',
    experimentId: '',
    baselineRunSpecId: '',
    candidateRunSpecId: '',
    rubricRevision: 'r1',
    rubricId: 'default',
    verdict: 'candidate' as Verdict,
  });

  const query = useQuery({
    queryKey: ['pairwise-evals', pairId, experimentId, verdict],
    queryFn: () => {
      const params = new URLSearchParams({
        ...(pairId ? { pairId } : {}),
        ...(experimentId ? { experimentId } : {}),
        ...(verdict ? { verdict } : {}),
      });
      return getJson<{ count: number; evals: PairwiseEval[] }>(`/run-evals/pairwise?${params}`);
    },
    refetchInterval: 30_000,
  });

  const rows = query.data?.evals ?? [];
  const selected = useMemo(
    () => rows.find(row => row.id === selectedId) ?? rows[0] ?? null,
    [rows, selectedId],
  );

  useEffect(() => {
    if (!selectedId && rows[0]) setSelectedId(rows[0].id);
    if (selectedId && rows.length > 0 && !rows.some(row => row.id === selectedId)) {
      setSelectedId(rows[0]?.id ?? null);
    }
  }, [rows, selectedId]);

  const record = useMutation({
    mutationFn: () => postJson('/run-evals/pairwise', {
      pairId: form.pairId.trim() || undefined,
      experimentId: form.experimentId.trim(),
      baselineRunSpecId: form.baselineRunSpecId.trim(),
      candidateRunSpecId: form.candidateRunSpecId.trim(),
      rubricRevision: form.rubricRevision.trim(),
      rubricSnapshot: {
        id: form.rubricId.trim() || 'default',
        revision: form.rubricRevision.trim(),
        criteria: [{ id: 'overall', label: 'Overall', maxScore: 5 }],
      },
      verdict: form.verdict,
      human: {
        source: 'web-console',
        verdict: form.verdict,
        criterionScores: [{ criterionId: 'overall', score: 0 }],
      },
    }),
    onSuccess: (response) => {
      setShowRecord(false);
      const createdId = (response as { eval?: { id?: string } } | undefined)?.eval?.id;
      if (createdId) setSelectedId(createdId);
      qc.invalidateQueries({ queryKey: ['pairwise-evals'] });
    },
  });

  return (
    <section className="page-evals page-pairwise-evals ops-page">
      <div className="page-toolbar">
        <div className="toolbar-tabs">
          <Scale size={15} />
          <strong>{t('ops.pairwise.title')}</strong>
        </div>
        <div className="toolbar-filters">
          <input
            className="filter-input"
            placeholder={t('ops.pairwise.pairIdPlaceholder')}
            value={pairId}
            onChange={e => setPairId(e.target.value)}
          />
          <input
            className="filter-input"
            placeholder={t('ops.pairwise.experimentIdPlaceholder')}
            value={experimentId}
            onChange={e => setExperimentId(e.target.value)}
          />
          <select
            className="filter-input"
            aria-label={t('ops.pairwise.verdictFilterAria')}
            value={verdict}
            onChange={e => setVerdict(e.target.value)}
          >
            <option value="">{t('ops.pairwise.allVerdicts')}</option>
            <option value="baseline">{t('ops.pairwise.verdictBaseline')}</option>
            <option value="candidate">{t('ops.pairwise.verdictCandidate')}</option>
            <option value="tie">{t('ops.pairwise.verdictTie')}</option>
            <option value="inconclusive">{t('ops.pairwise.verdictInconclusive')}</option>
          </select>
        </div>
        <div className="toolbar-actions">
          <Button variant="ghost" onClick={() => qc.invalidateQueries({ queryKey: ['pairwise-evals'] })}>
            <RefreshCcw size={14} /> {t('common.refresh')}
          </Button>
          <Button onClick={() => setShowRecord(v => !v)}>
            <Plus size={14} /> {t('ops.pairwise.recordPairButton')}
          </Button>
        </div>
      </div>

      {showRecord ? (
        <PairwiseRecordForm
          form={form}
          setForm={setForm}
          onSubmit={() => record.mutate()}
          pending={record.isPending}
          error={record.error}
        />
      ) : null}

      {query.error ? (
        <div className="error-banner" role="alert">
          {t('ops.pairwise.loadErrorPrefix', { error: readableError(query.error) })}
        </div>
      ) : null}

      <div className="panel-grid detail-grid pairwise-layout">
        <div className="panel pairwise-list-panel">
          {query.isLoading ? (
            <div className="loading-block">{t('ops.pairwise.loading')}</div>
          ) : rows.length === 0 ? (
            <EmptyGuide />
          ) : (
            <PairwiseTable rows={rows} selectedId={selected?.id ?? null} onSelect={setSelectedId} />
          )}
        </div>

        <aside className="panel inspector pairwise-detail-panel" aria-label={t('ops.pairwise.detailAria')}>
          {selected ? (
            <PairwiseDetail row={selected} onOpenRun={onOpenRun} onOpenSession={onOpenSession} />
          ) : (
            <EmptyText text={t('ops.pairwise.selectPrompt')} />
          )}
        </aside>
      </div>
    </section>
  );
}

function EmptyGuide() {
  const { t } = useI18n();
  return (
    <div className="empty-guide pairwise-empty-guide">
      <EmptyText text={t('ops.pairwise.noMatches')} />
      <p>{t('ops.pairwise.emptyGuideBody')}</p>
      <code className="pairwise-empty-code">tools/pairwise-sample-ingest.mts --experiment &lt;id&gt;</code>
      <p className="pairwise-empty-hint">{t('ops.pairwise.emptyGuideHint')}</p>
    </div>
  );
}

function PairwiseRecordForm({
  form,
  setForm,
  onSubmit,
  pending,
  error,
}: {
  form: {
    pairId: string;
    experimentId: string;
    baselineRunSpecId: string;
    candidateRunSpecId: string;
    rubricRevision: string;
    rubricId: string;
    verdict: Verdict;
  };
  setForm: (value: typeof form) => void;
  onSubmit: () => void;
  pending: boolean;
  error: Error | null;
}) {
  const { t } = useI18n();
  const update = (key: keyof typeof form, value: string) => setForm({ ...form, [key]: value });
  return (
    <div className="provider-edit-panel pairwise-record-form">
      <div className="provider-edit-grid">
        {(['pairId', 'experimentId', 'baselineRunSpecId', 'candidateRunSpecId', 'rubricRevision', 'rubricId'] as const).map(key => (
          <Field key={key} label={key}>
            <input value={form[key]} onChange={e => update(key, e.target.value)} />
          </Field>
        ))}
        <Field label={t('ops.pairwise.verdictLabel')}>
          <select value={form.verdict} onChange={e => update('verdict', e.target.value)}>
            <option value="candidate">{t('ops.pairwise.verdictCandidate')}</option>
            <option value="baseline">{t('ops.pairwise.verdictBaseline')}</option>
            <option value="tie">{t('ops.pairwise.verdictTie')}</option>
            <option value="inconclusive">{t('ops.pairwise.verdictInconclusive')}</option>
          </select>
        </Field>
      </div>
      <div className="provider-edit-meta">
        <Button onClick={onSubmit} disabled={pending}>
          {pending ? t('ops.pairwise.recording') : t('ops.pairwise.submitEvidenceButton')}
        </Button>
        {error ? <span className="error-banner" role="alert">{readableError(error)}</span> : null}
      </div>
    </div>
  );
}

function PairwiseTable({
  rows,
  selectedId,
  onSelect,
}: {
  rows: PairwiseEval[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const { t } = useI18n();
  return (
    <div className="pairwise-table-wrap">
      <table className="data-table">
        <thead>
          <tr>
            <th>{t('ops.pairwise.thPairExperiment')}</th>
            <th>{t('ops.pairwise.thBaseline')}</th>
            <th>{t('ops.pairwise.thCandidate')}</th>
            <th>{t('ops.pairwise.thVerdict')}</th>
            <th>{t('ops.pairwise.thChannels')}</th>
            <th>{t('ops.pairwise.thRubric')}</th>
            <th>{t('ops.pairwise.thCreated')}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(row => (
            <tr
              key={row.id}
              className="pairwise-row"
              data-active={selectedId === row.id}
              tabIndex={0}
              onClick={() => onSelect(row.id)}
              onKeyDown={event => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  onSelect(row.id);
                }
              }}
            >
              <td>
                <strong title={row.pairId}>{shortId(row.pairId)}</strong>
                <small title={row.experimentId}>{shortId(row.experimentId)}</small>
              </td>
              <td title={row.baselineRunSpecId}>{shortId(row.baselineRunSpecId)}</td>
              <td title={row.candidateRunSpecId}>{shortId(row.candidateRunSpecId)}</td>
              <td>
                <Badge tone={verdictTone(row.pairwiseVerdict)}>
                  {verdictLabel(row.pairwiseVerdict, t)}
                </Badge>
              </td>
              <td>
                <div className="pairwise-channel-chips" aria-label={t('ops.pairwise.thChannels')}>
                  <ChannelChip label={t('ops.pairwise.thHuman')} evidence={row.human} compact />
                  <ChannelChip label={t('ops.pairwise.thJudge')} evidence={row.judge} compact />
                  <ChannelChip label={t('ops.pairwise.thDeterministic')} evidence={row.deterministic} compact />
                </div>
              </td>
              <td title={row.rubricRevision}>{shortId(row.rubricRevision, 10)}</td>
              <td>{formatDate(row.createdAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
