import { ExternalLink } from 'lucide-react';
import { Badge, Fact, formatDate } from './ui';
import { useI18n } from './i18n';

export type Verdict = 'baseline' | 'candidate' | 'tie' | 'inconclusive';

export type CriterionScore = {
  criterionId?: string;
  score?: number;
  note?: string;
};

export type Evidence = {
  source?: string;
  verdict?: Verdict;
  verificationStatus?: string;
  confidence?: number;
  note?: string;
  criterionScores?: CriterionScore[];
};

export type RubricSnapshot = {
  id?: string;
  revision?: string;
  criteria?: Array<{ id?: string; label?: string; maxScore?: number; description?: string }>;
};

export type PairwiseEval = {
  id: string;
  pairId?: string;
  experimentId?: string;
  baselineRunSpecId?: string;
  candidateRunSpecId?: string;
  runSpecId?: string;
  sessionId?: string;
  rubricRevision?: string;
  rubricSnapshot?: RubricSnapshot;
  pairwiseVerdict?: Verdict;
  human?: Evidence;
  judge?: Evidence;
  deterministic?: Evidence;
  provider?: string;
  model?: string;
  success?: boolean;
  latencyMs?: number;
  verificationStatus?: string;
  summary?: Record<string, unknown>;
  createdAt: string;
  updatedAt?: string;
};

export function PairwiseDetail({
  row,
  onOpenRun,
  onOpenSession,
}: {
  row: PairwiseEval;
  onOpenRun?: (runSpecId: string) => void;
  onOpenSession?: (sessionId: string) => void;
}) {
  const { t } = useI18n();
  const scenarioId = typeof row.summary?.scenarioId === 'string' ? row.summary.scenarioId : undefined;
  const channelConflict = detectChannelConflict(row);

  return (
    <>
      <div className="panel-head compact">
        <div>
          <h2>{t('ops.pairwise.detailTitle')}</h2>
          <p className="pairwise-detail-subtitle" title={row.pairId ?? row.id}>
            {row.pairId ?? row.id}
          </p>
        </div>
        <Badge tone={verdictTone(row.pairwiseVerdict)}>
          {verdictLabel(row.pairwiseVerdict, t)}
        </Badge>
      </div>

      <div className="fact-list compact-facts">
        <Fact label={t('ops.pairwise.factExperiment')} value={row.experimentId ?? '—'} />
        <Fact label={t('ops.pairwise.factScenario')} value={scenarioId ?? '—'} />
        <Fact label={t('ops.pairwise.factRubric')} value={row.rubricRevision ?? '—'} />
        <Fact label={t('ops.pairwise.factProviderModel')} value={formatProviderModel(row.provider, row.model)} />
        <Fact label={t('ops.pairwise.factCreated')} value={formatDate(row.createdAt)} />
        <Fact
          label={t('ops.pairwise.factVerification')}
          value={row.verificationStatus ?? row.deterministic?.verificationStatus ?? '—'}
        />
      </div>

      {channelConflict ? (
        <div className="pairwise-conflict-banner" role="status">
          {t('ops.pairwise.channelConflict')}
        </div>
      ) : null}

      <div className="pairwise-run-compare">
        <RunSide title={t('ops.pairwise.thBaseline')} runSpecId={row.baselineRunSpecId} onOpenRun={onOpenRun} />
        <RunSide title={t('ops.pairwise.thCandidate')} runSpecId={row.candidateRunSpecId} onOpenRun={onOpenRun} />
      </div>

      {row.sessionId && onOpenSession ? (
        <div className="inline-actions pairwise-detail-actions">
          <button type="button" className="ghost-btn" onClick={() => onOpenSession(row.sessionId!)}>
            <ExternalLink size={14} /> {t('ops.pairwise.openSession')}
          </button>
        </div>
      ) : null}

      <div className="panel-head compact">
        <h2>{t('ops.pairwise.channelsTitle')}</h2>
      </div>
      <div className="pairwise-channel-stack">
        <EvidenceCard title={t('ops.pairwise.thHuman')} evidence={row.human} />
        <EvidenceCard title={t('ops.pairwise.thJudge')} evidence={row.judge} />
        <EvidenceCard title={t('ops.pairwise.thDeterministic')} evidence={row.deterministic} />
      </div>

      {row.rubricSnapshot?.criteria && row.rubricSnapshot.criteria.length > 0 ? (
        <>
          <div className="panel-head compact">
            <h2>{t('ops.pairwise.rubricTitle')}</h2>
          </div>
          <div className="definition-list">
            {row.rubricSnapshot.criteria.map(criterion => (
              <div className="definition" key={criterion.id ?? criterion.label}>
                <strong>{criterion.label ?? criterion.id ?? '—'}</strong>
                <span>
                  {criterion.id ?? '—'}
                  {criterion.maxScore !== undefined ? ` · max ${criterion.maxScore}` : ''}
                  {criterion.description ? ` — ${criterion.description}` : ''}
                </span>
              </div>
            ))}
          </div>
        </>
      ) : null}
    </>
  );
}

export function ChannelChip({
  label,
  evidence,
  compact = false,
}: {
  label: string;
  evidence?: Evidence;
  compact?: boolean;
}) {
  const { t } = useI18n();
  if (!evidence) {
    return (
      <span className={`pairwise-chip is-missing${compact ? ' is-compact' : ''}`} title={label}>
        {compact ? label.slice(0, 1) : t('ops.pairwise.channelMissing')}
      </span>
    );
  }
  const score = evidence.criterionScores?.[0]?.score;
  const text = compact
    ? `${label.slice(0, 1)}${evidence.verdict ? `:${evidence.verdict.slice(0, 1)}` : ''}`
    : `${evidence.verdict ?? evidence.source ?? t('ops.pairwise.channelPresent')}${score === undefined ? '' : ` (${score})`}`;
  return (
    <span
      className={`pairwise-chip is-present${compact ? ' is-compact' : ''}`}
      title={`${label}: ${evidence.verdict ?? evidence.source ?? ''}${score === undefined ? '' : ` (${score})`}`}
    >
      {text}
    </span>
  );
}

export function verdictTone(verdict?: Verdict): 'ok' | 'warn' | 'muted' | 'info' {
  if (verdict === 'candidate') return 'ok';
  if (verdict === 'baseline') return 'warn';
  if (verdict === 'tie') return 'info';
  return 'muted';
}

export function verdictLabel(verdict: Verdict | undefined, t: (key: string) => string): string {
  if (verdict === 'baseline') return t('ops.pairwise.verdictBaseline');
  if (verdict === 'candidate') return t('ops.pairwise.verdictCandidate');
  if (verdict === 'tie') return t('ops.pairwise.verdictTie');
  if (verdict === 'inconclusive') return t('ops.pairwise.verdictInconclusive');
  return '—';
}

export function shortId(value?: string, keep = 16): string {
  if (!value) return '—';
  return value.length <= keep ? value : `${value.slice(0, keep)}…`;
}

export function readableError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function RunSide({
  title,
  runSpecId,
  onOpenRun,
}: {
  title: string;
  runSpecId?: string;
  onOpenRun?: (runSpecId: string) => void;
}) {
  const { t } = useI18n();
  return (
    <div className="pairwise-run-side">
      <div className="pairwise-run-side-head">
        <strong>{title}</strong>
        {runSpecId && onOpenRun ? (
          <button type="button" className="ghost-btn" onClick={() => onOpenRun(runSpecId)}>
            <ExternalLink size={13} /> {t('ops.pairwise.openRun')}
          </button>
        ) : null}
      </div>
      <code className="pairwise-run-id" title={runSpecId}>{runSpecId ?? '—'}</code>
    </div>
  );
}

function EvidenceCard({ title, evidence }: { title: string; evidence?: Evidence }) {
  const { t } = useI18n();
  if (!evidence) {
    return (
      <div className="pairwise-evidence-card is-missing">
        <div className="pairwise-evidence-head">
          <strong>{title}</strong>
          <Badge tone="muted">{t('ops.pairwise.channelMissing')}</Badge>
        </div>
      </div>
    );
  }

  const scores = evidence.criterionScores ?? [];
  return (
    <div className="pairwise-evidence-card">
      <div className="pairwise-evidence-head">
        <strong>{title}</strong>
        <ChannelChip label={title} evidence={evidence} />
      </div>
      <div className="fact-list compact-facts">
        <Fact label={t('ops.pairwise.factSource')} value={evidence.source ?? '—'} />
        <Fact label={t('ops.pairwise.thVerdict')} value={evidence.verdict ?? '—'} />
        <Fact label={t('ops.pairwise.factVerification')} value={evidence.verificationStatus ?? '—'} />
        <Fact
          label={t('ops.pairwise.factConfidence')}
          value={evidence.confidence === undefined ? '—' : String(evidence.confidence)}
        />
      </div>
      {evidence.note ? <p className="pairwise-evidence-note">{evidence.note}</p> : null}
      {scores.length > 0 ? (
        <div className="definition-list">
          {scores.map((score, index) => (
            <div className="definition" key={`${score.criterionId ?? 'score'}-${index}`}>
              <strong>{score.criterionId ?? t('ops.pairwise.scoreFallback')}</strong>
              <span>
                {score.score === undefined ? '—' : score.score}
                {score.note ? ` — ${score.note}` : ''}
              </span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function detectChannelConflict(row: PairwiseEval): boolean {
  const verdicts = [row.human?.verdict, row.judge?.verdict, row.deterministic?.verdict]
    .filter((value): value is Verdict => Boolean(value));
  return new Set(verdicts).size > 1;
}

function formatProviderModel(provider?: string, model?: string): string {
  if (!provider && !model) return '—';
  if (provider && model) return `${provider} / ${model}`;
  return provider ?? model ?? '—';
}
