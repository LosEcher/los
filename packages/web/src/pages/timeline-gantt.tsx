/**
 * TimelineGantt — turn-laned duration swimlanes over session events.
 *
 * Projects timed events (model.response / tool.result / errors) onto absolute
 * time lanes, one lane per turn. Bar width = payload.durationMs relative to the
 * event window; color encodes status (model wait / tool ok / tool error /
 * denied / provider error). Clicking a bar selects it for the inspector.
 *
 * Design reference: DSH ui-trajectory Overview (real start/duration projection)
 * and Honeycomb agent timeline lanes.
 */
import { useMemo } from 'react';
import type { SessionEvent } from '../api';

export type GanttBarStatus = 'model' | 'tool-ok' | 'tool-error' | 'tool-denied' | 'error';

export interface GanttBar {
  id: number;
  turn: number;
  type: string;
  label: string;
  detail: string;
  status: GanttBarStatus;
  startMs: number;
  durationMs: number;
  event: SessionEvent;
}

const MIN_BAR_PX = 3;

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function barStatusFor(event: SessionEvent): GanttBarStatus {
  if (event.type === 'model.response') return 'model';
  if (event.type === 'tool.result') {
    const denied = event.payload?.denied === true;
    if (denied) return 'tool-denied';
    return event.payload?.ok === false ? 'tool-error' : 'tool-ok';
  }
  return 'error';
}

function barLabel(event: SessionEvent): string {
  if (event.type === 'model.response') return event.model ?? 'model';
  if (event.type.startsWith('tool.')) return event.toolName ?? event.type;
  return event.type;
}

/** Extract timed bars from the event stream. Events without duration still get a minimal marker. */
export function projectGanttBars(events: readonly SessionEvent[]): GanttBar[] {
  const bars: GanttBar[] = [];
  for (const event of events) {
    if (event.type !== 'model.response' && event.type !== 'tool.result'
      && event.type !== 'model.error' && event.type !== 'session.error') {
      continue;
    }
    const durationMs = numberOr(event.payload?.durationMs, 0);
    bars.push({
      id: event.id,
      turn: event.turn,
      type: event.type,
      label: barLabel(event),
      detail: durationMs > 0 ? `${durationMs}ms` : '—',
      status: barStatusFor(event),
      startMs: new Date(event.createdAt).getTime(),
      durationMs,
      event,
    });
  }
  return bars;
}

export function TimelineGantt({
  events,
  selectedId,
  onSelect,
}: {
  events: readonly SessionEvent[];
  selectedId: number | null;
  onSelect: (event: SessionEvent | null) => void;
}) {
  const { bars, turns, spanMs } = useMemo(() => {
    const bars = projectGanttBars(events);
    const turns = [...new Set(bars.map(bar => bar.turn))].sort((a, b) => a - b);
    if (bars.length === 0) return { bars, turns, spanMs: 0 };
    const starts = bars.map(bar => bar.startMs);
    const ends = bars.map(bar => bar.startMs + bar.durationMs);
    const min = Math.min(...starts);
    const max = Math.max(...ends);
    return { bars, turns, spanMs: Math.max(0, max - min) };
  }, [events]);

  const barWidth = (bar: GanttBar): number => {
    if (spanMs <= 0) return MIN_BAR_PX;
    return Math.max(MIN_BAR_PX, (bar.durationMs / spanMs) * 100);
  };

  const barLeft = (bar: GanttBar): number => {
    if (spanMs <= 0) return 0;
    return Math.max(0, ((bar.startMs - minStartMs()) / spanMs) * 100);
  };

  function minStartMs(): number {
    if (bars.length === 0) return 0;
    return Math.min(...bars.map(bar => bar.startMs));
  }

  if (bars.length === 0) {
    return (
      <div className="timeline-gantt timeline-gantt-empty">
        <span>—</span>
      </div>
    );
  }

  return (
    <div className="timeline-gantt">
      <div className="timeline-gantt-scale">
        <span>{new Date(minStartMs()).toLocaleTimeString()}</span>
        <span>{new Date(minStartMs() + spanMs).toLocaleTimeString()}</span>
      </div>
      <div className="timeline-gantt-body">
        {turns.map(turn => (
          <div className="timeline-lane" key={turn}>
            <span className="timeline-lane-label" title={`turn ${turn}`}>
              {turn}
            </span>
            <div className="timeline-lane-track">
              {bars
                .filter(bar => bar.turn === turn)
                .map(bar => (
                  <button
                    key={bar.id}
                    type="button"
                    className={`timeline-bar is-${bar.status}${selectedId === bar.id ? ' is-selected' : ''}`}
                    style={{ left: `${barLeft(bar)}%`, width: `${barWidth(bar)}%` }}
                    title={`${bar.label} · ${bar.type} · ${bar.detail}${bar.event.model ? ` · ${bar.event.model}` : ''}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      onSelect(selectedId === bar.id ? null : bar.event);
                    }}
                    aria-label={`${bar.label} ${bar.detail}`}
                  />
                ))}
            </div>
          </div>
        ))}
      </div>
      <div className="timeline-legend">
        <span className="timeline-legend-item"><i className="tl-dot is-model" />model</span>
        <span className="timeline-legend-item"><i className="tl-dot is-tool-ok" />tool</span>
        <span className="timeline-legend-item"><i className="tl-dot is-tool-error" />error</span>
        <span className="timeline-legend-item"><i className="tl-dot is-tool-denied" />denied</span>
      </div>
    </div>
  );
}
