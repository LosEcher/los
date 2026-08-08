import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle, X } from 'lucide-react';
import { getJson, postJson } from '../api/index.js';
import { DataTable, EmptyText, StatusPill, Fact } from '../ui.js';
import { useI18n } from '../i18n';

interface DeadLetterEvent {
  id: string;
  taskRunId: string | null;
  runSpecId: string | null;
  reason: string;
  originalError: string | null;
  eventPayload: Record<string, unknown>;
  acknowledgedAt: string | null;
  resolution: DeadLetterResolution | 'legacy_acknowledged' | null;
  resolutionNote: string | null;
  replacementTaskRunId: string | null;
  resolvedBy: string | null;
  resolvedAt: string | null;
  createdAt: string;
}

type DeadLetterResolution = 'replaced' | 'superseded' | 'accepted_loss' | 'regression_covered';

interface DeadLetterResolutionInput {
  id: string;
  resolution: DeadLetterResolution;
  note?: string;
  replacementTaskRunId?: string;
}

export function DeadLetterPage() {
  const { t } = useI18n();
  const queryClient = useQueryClient();

  const dlq = useQuery({
    queryKey: ['dead-letter'],
    queryFn: async () => {
      const [unresolved, resolved] = await Promise.all([
        getJson<DeadLetterEvent[]>('/tasks/dead-letter?acknowledged=false&limit=200'),
        getJson<DeadLetterEvent[]>('/tasks/dead-letter?acknowledged=true&limit=200'),
      ]);
      return [...unresolved, ...resolved]
        .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt));
    },
    refetchInterval: 30_000,
  });

  const ack = useMutation({
    mutationFn: ({ id, ...body }: DeadLetterResolutionInput) =>
      postJson<DeadLetterEvent>(`/tasks/dead-letter/${id}/ack`, body),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['dead-letter'] });
    },
  });

  const events = dlq.data ?? [];
  const unacked = events.filter(e => !e.acknowledgedAt);
  const acked = events.filter(e => e.acknowledgedAt);

  return (
    <section className="panel-grid ops-page">
      <div className="panel">
        <div className="panel-head">
          <div>
            <h2>{t('ops.deadLetter.title')}</h2>
            <p>{t('ops.deadLetter.subtitle')}</p>
          </div>
          <StatusPill status={unacked.length > 0 ? 'live' : 'partial'} />
        </div>

        <div className="fact-list" style={{ marginBottom: 16 }}>
          <Fact label={t('ops.deadLetter.factUnacknowledged')} value={String(unacked.length)} />
          <Fact label={t('ops.deadLetter.factAcknowledged')} value={String(acked.length)} />
          <Fact label={t('ops.deadLetter.factTotal')} value={String(events.length)} />
        </div>

        <DataTable
          loading={dlq.isLoading}
          empty={t('ops.deadLetter.empty')}
          rows={events}
          renderRow={(e) => (
            <div key={e.id} className={`record-row dead-letter-row ${e.acknowledgedAt ? 'record-dim' : ''}`}>
              <div className="record-main">
                <div className="record-header">
                  <strong className="record-title">{e.reason}</strong>
                  {e.acknowledgedAt ? (
                    <span className="status-pill partial">{t('ops.deadLetter.resolvedPill')}</span>
                  ) : (
                    <span className="status-pill live">{t('ops.deadLetter.attentionPill')}</span>
                  )}
                </div>
                <div className="record-meta">
                  {e.taskRunId ? <span>{t('ops.deadLetter.taskShort', { id: e.taskRunId.slice(0, 12) })}</span> : null}
                  {e.runSpecId ? <span> · {t('ops.deadLetter.runShort', { id: e.runSpecId.slice(0, 12) })}</span> : null}
                  <span> · {new Date(e.createdAt).toLocaleString()}</span>
                  {e.acknowledgedAt ? <span> · {t('ops.deadLetter.ackedPrefix', { date: new Date(e.acknowledgedAt).toLocaleString() })}</span> : null}
                </div>
                {e.originalError ? (
                  <div className="record-detail">
                    {e.originalError.length > 300 ? e.originalError.slice(0, 300) + '...' : e.originalError}
                  </div>
                ) : null}
                {e.acknowledgedAt ? (
                  <div className="dead-letter-resolution-summary">
                    <strong>{e.resolution ?? 'legacy_acknowledged'}</strong>
                    {e.replacementTaskRunId ? <span>{t('ops.deadLetter.replacementPrefix', { id: e.replacementTaskRunId })}</span> : null}
                    {e.resolutionNote ? <span>{e.resolutionNote}</span> : null}
                    {e.resolvedBy ? <span>{t('ops.deadLetter.resolvedByPrefix', { name: e.resolvedBy })}</span> : null}
                  </div>
                ) : (
                  <DeadLetterResolutionForm
                    eventId={e.id}
                    pending={ack.isPending}
                    error={ack.isError ? ack.error : null}
                    onResolve={input => ack.mutate(input)}
                  />
                )}
              </div>
            </div>
          )}
        />
      </div>
    </section>
  );
}

function DeadLetterResolutionForm({
  eventId,
  pending,
  error,
  onResolve,
}: {
  eventId: string;
  pending: boolean;
  error: Error | null;
  onResolve: (input: DeadLetterResolutionInput) => void;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [resolution, setResolution] = useState<DeadLetterResolution>('regression_covered');
  const [note, setNote] = useState('');
  const [replacementTaskRunId, setReplacementTaskRunId] = useState('');
  const needsReplacement = resolution === 'replaced';
  const needsNote = resolution === 'accepted_loss';
  const valid = (!needsReplacement || replacementTaskRunId.trim().length > 0)
    && (!needsNote || note.trim().length > 0);

  if (!open) {
    return (
      <button type="button" className="ghost-btn tiny-btn" onClick={() => setOpen(true)}>
        <CheckCircle size={12} /> {t('ops.deadLetter.resolveButton')}
      </button>
    );
  }

  return (
    <form
      className="dead-letter-resolution-form"
      onSubmit={event => {
        event.preventDefault();
        if (!valid) return;
        onResolve({
          id: eventId,
          resolution,
          note: note.trim() || undefined,
          replacementTaskRunId: replacementTaskRunId.trim() || undefined,
        });
      }}
    >
      <label className="field">
        <span>{t('ops.deadLetter.resolutionLabel')}</span>
        <select value={resolution} onChange={event => setResolution(event.target.value as DeadLetterResolution)}>
          <option value="regression_covered">{t('ops.deadLetter.resolutionRegressionCovered')}</option>
          <option value="superseded">{t('ops.deadLetter.resolutionSuperseded')}</option>
          <option value="replaced">{t('ops.deadLetter.resolutionReplaced')}</option>
          <option value="accepted_loss">{t('ops.deadLetter.resolutionAcceptedLoss')}</option>
        </select>
      </label>
      {needsReplacement ? (
        <label className="field">
          <span>{t('ops.deadLetter.replacementLabel')}</span>
          <input
            value={replacementTaskRunId}
            onChange={event => setReplacementTaskRunId(event.target.value)}
            placeholder={t('ops.deadLetter.taskRunIdPlaceholder')}
            required
          />
        </label>
      ) : null}
      <label className="field dead-letter-note-field">
        <span>{t('ops.deadLetter.noteLabel')}{needsNote ? ' *' : ''}</span>
        <input
          value={note}
          onChange={event => setNote(event.target.value)}
          placeholder={needsNote ? t('ops.deadLetter.noteRequiredPlaceholder') : t('ops.deadLetter.noteOptionalPlaceholder')}
          required={needsNote}
        />
      </label>
      <div className="dead-letter-resolution-actions">
        <button type="submit" className="tiny-btn" disabled={pending || !valid}>
          <CheckCircle size={12} /> {t('ops.deadLetter.confirmButton')}
        </button>
        <button type="button" className="icon-btn" title={t('ops.deadLetter.cancelResolutionTitle')} onClick={() => setOpen(false)} disabled={pending}>
          <X size={14} />
        </button>
      </div>
      {error ? <span className="field-error">{error.message}</span> : null}
    </form>
  );
}
