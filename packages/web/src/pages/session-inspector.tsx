/**
 * Session inspector components — event timeline, expandable events, turn groups.
 * Extracted from sessions-page.tsx to keep it under the 400-line module gate.
 */
import { useState } from 'react';
import { formatTime } from '../ui.js';
import type { SessionEvent } from '../api';

// ── Event classification ──────────────────────────

export function eventCategory(type: string): string {
  if (type.startsWith('session.')) return 'session';
  if (type.startsWith('model.')) return 'model';
  if (type.startsWith('tool.')) return 'tool';
  if (type.startsWith('task.')) return 'task';
  return 'other';
}

/** Internal state-machine events that duplicate richer tool.* events.
 *  Hidden by default in the inspector timeline to reduce noise. */
export const HIDDEN_INSPECTOR_EVENTS = new Set([
  'tool_call_state.approved',
  'tool_call_state.running',
  'tool_call_state.succeeded',
  'tool_call_state.failed',
  'tool_call_state.denied',
  'tool_call_state.requested',
  'tool_call_state.fallback_update',
]);

export const TRUNCATED_PAYLOAD_CHARS = 4000;

// ── Summaries ──────────────────────────────────────

export function eventPayloadSummary(event: {
  type: string;
  payload?: Record<string, unknown>;
  usage?: { totalTokens: number; promptTokens: number; completionTokens: number };
}): string | null {
  const p = event.payload;
  if (!p) return null;

  // Tool call state transitions (audit events that pass the filter)
  if (event.type.startsWith('tool_call_state.') || event.type.startsWith('execution_state.')) {
    if (typeof p.reason === 'string' && p.reason) return truncateSummary(p.reason, 80);
    return null;
  }

  // Error previews
  if (typeof p.errorPreview === 'string' && p.errorPreview) return `error: ${truncateSummary(p.errorPreview, 80)}`;

  // Session lifecycle
  if (event.type === 'session.started') {
    const parts: string[] = [];
    if (typeof p.promptPreview === 'string') parts.push(`prompt: ${truncateSummary(p.promptPreview, 60)}`);
    if (typeof p.effectiveModel === 'string') parts.push(p.effectiveModel);
    if (typeof p.toolMode === 'string') parts.push(p.toolMode);
    return parts.join(' · ') || null;
  }

  // Tool catalog
  if (event.type === 'tool.catalog' && typeof p.count === 'number') return `${p.count} tools available`;

  // Model responses
  if (event.type === 'model.response') {
    const parts: string[] = [];
    if (typeof p.durationMs === 'number') parts.push(formatDurationCompact(p.durationMs));
    if (event.usage && event.usage.totalTokens > 0) parts.push(`${event.usage.totalTokens} tokens`);
    if (typeof p.toolCallCount === 'number' && p.toolCallCount > 0) parts.push(`${p.toolCallCount} tool calls`);
    if (parts.length === 0 && typeof p.toolCalls === 'object') {
      const calls = p.toolCalls as Array<Record<string, unknown>>;
      if (Array.isArray(calls) && calls.length > 0) parts.push(calls.map(c => String(c.name ?? '?')).join(', '));
    }
    return parts.join(' · ') || null;
  }

  // Tool results
  if (event.type === 'tool.result') {
    const parts: string[] = [];
    if (p.ok === true) parts.push('✅');
    else if (p.ok === false) parts.push('❌');
    if (typeof p.durationMs === 'number') parts.push(formatDurationCompact(p.durationMs));
    if (typeof p.contentPreview === 'string' && p.contentPreview) parts.push(truncateSummary(p.contentPreview, 50));
    else if (typeof p.contentLength === 'number') parts.push(`${p.contentLength} chars output`);
    return parts.join(' ') || null;
  }

  if (event.type === 'tool.call') {
    const argsSource = p.argsPreview ?? p.args;
    if (typeof argsSource === 'string') return truncateSummary(argsSource, 60);
    if (argsSource && typeof argsSource === 'object') {
      return truncateSummary(JSON.stringify(argsSource), 60);
    }
    if (typeof p.callId === 'string') return `call: ${truncateSummary(p.callId, 12)}`;
    return null;
  }

  // Tool planned / approved — show policy decision
  if (event.type === 'tool.planned' || event.type === 'tool.approved') {
    if (typeof p.callId === 'string') {
      const allowed = p.allowed;
      const tag = event.type === 'tool.approved'
        ? (allowed === false ? '❌ denied' : '✅ approved')
        : 'planned';
      return `${tag} · ${truncateSummary(p.callId, 12)}`;
    }
    return null;
  }

  // Task lifecycle
  if (event.type === 'task.created' || event.type === 'task.running') return `status: ${p.status ?? '?'}`;
  if (event.type === 'task.cancelled') return `❌ ${p.reason ?? 'cancelled'}`;
  if (event.type === 'task.completed') return `✅ ${p.status ?? 'completed'}`;

  // Generic fallback: common fields
  if (typeof p.textPreview === 'string' && p.textPreview) return truncateSummary(p.textPreview, 60);
  if (typeof p.contentPreview === 'string' && p.contentPreview) return truncateSummary(p.contentPreview, 60);
  if (typeof p.message === 'string' && p.message) return truncateSummary(p.message, 60);
  if (typeof p.toolCalls === 'object') {
    const calls = p.toolCalls as Array<Record<string, unknown>>;
    if (Array.isArray(calls) && calls.length > 0) {
      return calls.map(c => String(c.name ?? '?')).join(', ');
    }
  }
  if (typeof p.callId === 'string') return `call: ${truncateSummary(p.callId, 12)}`;
  return null;
}

export function truncateSummary(text: string, maxLen: number): string {
  return text.length > maxLen ? text.slice(0, maxLen) + '…' : text;
}

export function formatDurationCompact(ms: number): string {
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`;
  return `${ms}ms`;
}

function formatPayloadForDisplay(payload: Record<string, unknown>): string {
  const raw = JSON.stringify(payload, null, 2);
  if (raw.length <= TRUNCATED_PAYLOAD_CHARS) return raw;
  return raw.slice(0, TRUNCATED_PAYLOAD_CHARS) + `\n\n… [truncated ${raw.length - TRUNCATED_PAYLOAD_CHARS} chars]`;
}

// ── Components ─────────────────────────────────────

export function ExpandableEvent({ event, category, isNewTurn, payloadSummary }: {
  event: SessionEvent;
  category: string;
  isNewTurn: boolean;
  payloadSummary: string | null;
}) {
  const [open, setOpen] = useState(false);
  const hasPayload = event.payload && Object.keys(event.payload).length > 0;

  return (
    <>
      <div
        className={`event-line${isNewTurn ? ' turn-break' : ''}${hasPayload ? ' clickable' : ''}`}
        data-category={category}
        onClick={() => hasPayload && setOpen(!open)}
      >
        <span className="event-time">{formatTime(event.createdAt)}</span>
        <span className={`event-dot ${category}`} />
        <strong>{open ? '▾' : hasPayload ? '▸' : ' '} {event.type}</strong>
        {event.toolName ? <em>{event.toolName}</em> : null}
        {event.model ? <em className="event-model">{event.model}</em> : null}
        {payloadSummary ? <span className="event-summary">{payloadSummary}</span> : null}
      </div>
      {open && hasPayload ? (
        <pre className="event-payload">{formatPayloadForDisplay(event.payload)}</pre>
      ) : null}
    </>
  );
}

export function TurnGroup({ turn, events, children }: {
  turn: number;
  events: SessionEvent[];
  children: React.ReactNode;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const modelResponse = events.find(e => e.type === 'model.response');
  const toolResults = events.filter(e => e.type === 'tool.result');
  const modelDuration = Number(modelResponse?.payload?.durationMs) || 0;
  const totalToolDuration = toolResults.reduce((sum, e) => sum + (Number(e.payload?.durationMs) || 0), 0);
  const tokenCount = modelResponse?.usage?.totalTokens ?? 0;

  return (
    <div className="turn-group" data-turn={turn}>
      <div className="turn-group-head" onClick={() => setCollapsed(!collapsed)}>
        <span className="turn-label">Turn {turn}</span>
        {tokenCount > 0 ? <span className="turn-metric">{tokenCount} tokens</span> : null}
        {modelDuration > 0 ? <span className="turn-metric">model: {formatDurationCompact(modelDuration)}</span> : null}
        {totalToolDuration > 0 ? <span className="turn-metric">tools: {formatDurationCompact(totalToolDuration)}</span> : null}
        {toolResults.length > 0 ? <span className="turn-metric">{toolResults.length} tool{toolResults.length !== 1 ? 's' : ''}</span> : null}
        <span className="turn-toggle">{collapsed ? '▶' : '▼'}</span>
      </div>
      {!collapsed ? <div className="turn-group-body">{children}</div> : null}
    </div>
  );
}
