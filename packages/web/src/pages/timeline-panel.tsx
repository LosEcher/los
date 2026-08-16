/**
 * TimelinePanel — session execution timeline: duration swimlanes + event
 * inspector. Complements ExecutionObservabilityPanel (aggregate facts) with an
 * absolute-time visual (gantt) and per-event detail (timing / usage / parent
 * chain), following the DSH ui-trajectory Overview + inspector pattern.
 */
import { useState } from 'react';
import { Clock, GitBranch } from 'lucide-react';
import type { SessionEvent } from '../api';
import { useI18n } from '../i18n';
import { formatDurationCompact, truncateSummary } from './session-inspector.js';
import { TimelineGantt } from './timeline-gantt.js';

export function TimelinePanel({
  sessionId,
  events,
}: {
  sessionId: string | null;
  events: readonly SessionEvent[];
}) {
  const { t } = useI18n();
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const selected = selectedId === null ? null : events.find(event => event.id === selectedId) ?? null;

  const select = (event: SessionEvent | null) => setSelectedId(event ? event.id : null);

  return (
    <section className="timeline-panel" aria-label={t('assets.timeline.sectionAria')}>
      <div className="timeline-head">
        <Clock size={14} />
        <strong>{t('assets.timeline.title')}</strong>
      </div>
      <TimelineGantt events={events} selectedId={selectedId} onSelect={select} />
      {selected ? (
        <EventInspector event={selected} events={events} onClose={() => select(null)} />
      ) : (
        <p className="timeline-hint">{t('assets.timeline.selectHint')}</p>
      )}
      {events.length === 0 ? (
        <p className="timeline-hint">{t('assets.timeline.noEvents', { sessionId: sessionId ?? '' })}</p>
      ) : null}
    </section>
  );
}

function EventInspector({
  event,
  events,
  onClose,
}: {
  event: SessionEvent;
  events: readonly SessionEvent[];
  onClose: () => void;
}) {
  const { t } = useI18n();
  const durationMs = typeof event.payload?.durationMs === 'number'
    ? event.payload.durationMs
    : undefined;
  const parent = event.parentEventId === undefined
    ? null
    : events.find(candidate => candidate.id === event.parentEventId) ?? null;
  const usage = event.usage;
  const payloadText = truncateSummary(safeStringify(event.payload), 600);

  return (
    <div className="timeline-inspector" role="dialog" aria-label={t('assets.timeline.inspectorAria')}>
      <div className="timeline-inspector-head">
        <code className="timeline-inspector-type">{event.type}</code>
        <button type="button" className="ghost-btn" onClick={onClose}>✕</button>
      </div>
      <dl className="timeline-inspector-facts">
        <dt>{t('assets.label.turns')}</dt><dd>#{event.turn}</dd>
        {event.model ? <><dt>{t('assets.label.model')}</dt><dd>{event.model}</dd></> : null}
        {event.toolName ? <><dt>{t('assets.timeline.tool')}</dt><dd>{event.toolName}</dd></> : null}
        <dt>{t('assets.timeline.time')}</dt><dd>{new Date(event.createdAt).toLocaleTimeString()}</dd>
        {durationMs !== undefined ? (
          <><dt>{t('assets.timeline.duration')}</dt><dd>{formatDurationCompact(durationMs)}</dd></>
        ) : null}
      </dl>
      {usage ? (
        <div className="timeline-inspector-usage">
          <strong>{t('assets.timeline.tokens')}</strong>
          <span>{usage.promptTokens}↑ / {usage.completionTokens}↓{usage.cacheHitTokens ? ` / cache ${usage.cacheHitTokens}` : ''}{usage.totalTokens ? ` = ${usage.totalTokens}` : ''}</span>
        </div>
      ) : null}
      {parent ? (
        <div className="timeline-inspector-parent">
          <GitBranch size={12} />
          <span>{t('assets.timeline.parent')}</span>
          <code>{parent.type}</code>
          {parent.toolName ? <span>· {parent.toolName}</span> : null}
          <button
            type="button"
            className="ghost-btn"
            onClick={() => document.getElementById(`tl-event-${parent.id}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' })}
          >
            {t('assets.timeline.locate')}
          </button>
        </div>
      ) : null}
      {payloadText ? (
        <pre className="timeline-inspector-payload">{payloadText}</pre>
      ) : null}
    </div>
  );
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}
