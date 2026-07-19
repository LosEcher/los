import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, RefreshCcw, Scale } from 'lucide-react';
import { getJson, postJson } from './api';
import { Badge, Button, EmptyText, Field, formatDate } from './ui';

type Verdict = 'baseline' | 'candidate' | 'tie' | 'inconclusive';
type Evidence = { source?: string; verdict?: Verdict; verificationStatus?: string; criterionScores?: Array<{ score: number }> };
type PairwiseEval = {
  id: string; pairId?: string; experimentId?: string; baselineRunSpecId?: string; candidateRunSpecId?: string;
  rubricRevision?: string; pairwiseVerdict?: Verdict; human?: Evidence; judge?: Evidence; deterministic?: Evidence;
  provider?: string; model?: string; createdAt: string;
};

export function PairwiseEvalsPage() {
  const qc = useQueryClient();
  const [pairId, setPairId] = useState('');
  const [experimentId, setExperimentId] = useState('');
  const [verdict, setVerdict] = useState('');
  const [showRecord, setShowRecord] = useState(false);
  const [form, setForm] = useState({ pairId: '', experimentId: '', baselineRunSpecId: '', candidateRunSpecId: '', rubricRevision: 'r1', rubricId: 'default', verdict: 'candidate' as Verdict });
  const query = useQuery({
    queryKey: ['pairwise-evals', pairId, experimentId, verdict],
    queryFn: () => getJson<{ count: number; evals: PairwiseEval[] }>(`/run-evals/pairwise?${new URLSearchParams({ ...(pairId ? { pairId } : {}), ...(experimentId ? { experimentId } : {}), ...(verdict ? { verdict } : {}) })}`),
    refetchInterval: 30_000,
  });
  const record = useMutation({
    mutationFn: () => postJson('/run-evals/pairwise', {
      pairId: form.pairId.trim() || undefined,
      experimentId: form.experimentId.trim(),
      baselineRunSpecId: form.baselineRunSpecId.trim(),
      candidateRunSpecId: form.candidateRunSpecId.trim(),
      rubricRevision: form.rubricRevision.trim(),
      rubricSnapshot: { id: form.rubricId.trim() || 'default', revision: form.rubricRevision.trim(), criteria: [{ id: 'overall', label: 'Overall', maxScore: 5 }] },
      verdict: form.verdict,
      human: { source: 'web-console', verdict: form.verdict, criterionScores: [{ criterionId: 'overall', score: 0 }] },
    }),
    onSuccess: () => { setShowRecord(false); qc.invalidateQueries({ queryKey: ['pairwise-evals'] }); },
  });

  return (
    <section className="page-evals page-pairwise-evals">
      <div className="page-toolbar">
        <div className="toolbar-tabs"><Scale size={15} /><strong>Pairwise evaluation</strong></div>
        <div className="toolbar-filters">
          <input className="filter-input" placeholder="Pair ID..." value={pairId} onChange={e => setPairId(e.target.value)} />
          <input className="filter-input" placeholder="Experiment ID..." value={experimentId} onChange={e => setExperimentId(e.target.value)} />
          <select className="filter-input" aria-label="Verdict filter" value={verdict} onChange={e => setVerdict(e.target.value)}>
            <option value="">All verdicts</option><option value="baseline">Baseline</option><option value="candidate">Candidate</option><option value="tie">Tie</option><option value="inconclusive">Inconclusive</option>
          </select>
        </div>
        <div className="toolbar-actions">
          <Button variant="ghost" onClick={() => qc.invalidateQueries({ queryKey: ['pairwise-evals'] })}><RefreshCcw size={14} /> Refresh</Button>
          <Button onClick={() => setShowRecord(v => !v)}><Plus size={14} /> Record pair</Button>
        </div>
      </div>
      {showRecord ? <PairwiseRecordForm form={form} setForm={setForm} onSubmit={() => record.mutate()} pending={record.isPending} error={record.error} /> : null}
      {query.isLoading ? <div className="loading-block">Loading pairwise evidence...</div> : query.data?.evals.length ? <PairwiseTable rows={query.data.evals} /> : <EmptyText text="No pairwise evaluations match these filters." />}
    </section>
  );
}

function PairwiseRecordForm({ form, setForm, onSubmit, pending, error }: { form: { pairId: string; experimentId: string; baselineRunSpecId: string; candidateRunSpecId: string; rubricRevision: string; rubricId: string; verdict: Verdict }; setForm: (value: typeof form) => void; onSubmit: () => void; pending: boolean; error: Error | null }) {
  const update = (key: keyof typeof form, value: string) => setForm({ ...form, [key]: value });
  return <div className="provider-edit-panel pairwise-record-form"><div className="provider-edit-grid">
    {(['pairId', 'experimentId', 'baselineRunSpecId', 'candidateRunSpecId', 'rubricRevision', 'rubricId'] as const).map(key => <Field key={key} label={key}><input value={form[key]} onChange={e => update(key, e.target.value)} /></Field>)}
    <Field label="verdict"><select value={form.verdict} onChange={e => update('verdict', e.target.value)}><option value="candidate">Candidate</option><option value="baseline">Baseline</option><option value="tie">Tie</option><option value="inconclusive">Inconclusive</option></select></Field>
  </div><div className="provider-edit-meta"><Button onClick={onSubmit} disabled={pending}>{pending ? 'Recording...' : 'Submit evidence'}</Button>{error ? <span className="error-banner">{String(error)}</span> : null}</div></div>;
}

function PairwiseTable({ rows }: { rows: PairwiseEval[] }) {
  return <div className="pairwise-table-wrap"><table className="data-table"><thead><tr><th>Pair / experiment</th><th>Baseline</th><th>Candidate</th><th>Verdict</th><th>Human</th><th>Judge</th><th>Deterministic</th><th>Rubric</th><th>Created</th></tr></thead><tbody>{rows.map(row => <tr key={row.id}>
    <td><strong>{row.pairId ?? '-'}</strong><small>{row.experimentId ?? '-'}</small></td><td>{row.baselineRunSpecId ?? '-'}</td><td>{row.candidateRunSpecId ?? '-'}</td><td><Badge tone={row.pairwiseVerdict === 'candidate' ? 'ok' : row.pairwiseVerdict === 'baseline' ? 'warn' : 'muted'}>{row.pairwiseVerdict ?? '-'}</Badge></td>
    <td>{evidenceLabel(row.human)}</td><td>{evidenceLabel(row.judge)}</td><td>{row.deterministic?.verificationStatus ?? '-'}</td><td>{row.rubricRevision ?? '-'}</td><td>{formatDate(row.createdAt)}</td>
  </tr>)}</tbody></table></div>;
}

function evidenceLabel(evidence?: Evidence): string {
  if (!evidence) return '-';
  const score = evidence.criterionScores?.[0]?.score;
  return `${evidence.verdict ?? evidence.source ?? '-'}${score === undefined ? '' : ` (${score})`}`;
}
