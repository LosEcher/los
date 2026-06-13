/**
 * Chat helpers — model helpers, history builder, stream row renderer.
 * Extracted from chat-page.tsx.
 */

import type {
  ProviderDiscovery, ProviderModelsResponse, ModelSettings,
  ProviderModelRoute,
  SessionEvent, SessionEventsResponse,
  TodoItem,
} from './api';

export type StreamRow = {
  id: string; event: string; message: string;
  meta?: string; level?: 'normal' | 'ok' | 'warn' | 'error';
};

export type ProviderOption = {
  id: string; label: string; source: string;
  defaultModel: string; state: string; hasApiKey?: boolean;
};

export const SUPPRESSED_STREAM_EVENTS = new Set([
  'session.started', 'session.completed', 'tool.catalog',
  'model.turn.started', 'tool.planned', 'tool.approved',
]);

export function readyStreamRows(): StreamRow[] {
  return [{
    id: 'ready',
    event: 'system',
    message: 'Choose a project, provider, model, and tool mode before sending.',
    meta: 'project tools can edit files; choose all tools when the run needs shell commands',
  }];
}

export function buildProviderOptions(discovery?: ProviderDiscovery, routes?: ProviderModelsResponse): ProviderOption[] {
  const results: ProviderOption[] = [];
  const seen = new Set<string>();
  for (const provider of providerRoutesFromModels(routes)) {
    if (seen.has(provider.provider)) continue;
    seen.add(provider.provider);
    const disc = (discovery?.providers ?? []).find(d => d.provider === provider.provider || d.name === provider.provider);
    results.push({
      id: provider.provider, label: provider.provider,
      source: provider.source ?? disc?.source ?? 'configured',
      defaultModel: provider.model ?? disc?.defaultModel ?? 'unknown',
      state: provider.ok ? 'ok' : (provider.error ?? 'unavailable'),
      hasApiKey: provider.hasApiKey,
    });
  }
  for (const disc of discovery?.providers ?? []) {
    const name = String(disc.provider ?? disc.name ?? '');
    if (!name || seen.has(name)) continue;
    seen.add(name);
    results.push({
      id: name, label: name,
      source: String(disc.source ?? 'discovered'),
      defaultModel: String(disc.defaultModel ?? disc.model ?? 'unknown'),
      state: (disc.readiness as Record<string, unknown> | undefined)?.ready ? 'ready' : 'discovered',
      hasApiKey: Boolean(disc.hasApiKey),
    });
  }
  return results;
}

export function providerRoutesFromModels(routes?: ProviderModelsResponse): ProviderModelRoute[] {
  if (!routes) return [];
  if (Array.isArray(routes.providers) && routes.providers.length > 0) return routes.providers;

  const grouped = new Map<string, ProviderModelRoute>();
  for (const model of routes.models ?? []) {
    const existing = grouped.get(model.provider);
    const modelInfo = { id: model.model };
    if (existing) {
      if (!existing.models.some(item => item.id === model.model)) existing.models.push(modelInfo);
      existing.count = existing.models.length;
      existing.ok = existing.ok || model.enabled === true;
      existing.enabled = existing.enabled || model.enabled === true;
      existing.hasApiKey = existing.hasApiKey || model.hasApiKey === true;
      existing.source = existing.source ?? model.source ?? null;
      existing.baseUrl = existing.baseUrl ?? model.baseUrl ?? null;
      continue;
    }
    grouped.set(model.provider, {
      provider: model.provider,
      ok: model.enabled === true,
      enabled: model.enabled,
      hasApiKey: model.hasApiKey,
      source: model.source ?? null,
      model: model.model,
      baseUrl: model.baseUrl ?? null,
      count: 1,
      models: [modelInfo],
    });
  }
  return [...grouped.values()];
}

export function metadataText(value: unknown): string | null {
  if (typeof value === 'string') { const t = value.trim(); return t || null; }
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return null;
}

export function buildModelSettingsPayload(input: Record<keyof ModelSettings, string>): ModelSettings | undefined {
  const out: Record<string, number> = {};
  for (const key of ['temperature', 'topP', 'maxTokens', 'presencePenalty', 'frequencyPenalty'] as const) {
    const v = (input as Record<string, string>)[key];
    if (v !== undefined && v !== '') {
      const n = Number(v);
      if (Number.isFinite(n)) out[key] = n;
    }
  }
  return Object.keys(out).length > 0 ? (out as unknown as ModelSettings) : undefined;
}

export function parseCommaList(value: string): string[] | undefined {
  const items = value.split(',').map(s => s.trim()).filter(Boolean);
  return items.length > 0 ? [...new Set(items)] : undefined;
}

export function buildToolRetryPayload(input: { maxAttempts: string; baseDelayMs: string; maxDelayMs: string }) {
  const maxAttempts = intOrUndef(input.maxAttempts);
  const baseDelayMs = intOrUndef(input.baseDelayMs);
  const maxDelayMs = intOrUndef(input.maxDelayMs);
  if (maxAttempts === undefined && baseDelayMs === undefined && maxDelayMs === undefined) return undefined;
  const r: Record<string, number> = {};
  if (maxAttempts !== undefined) r.maxAttempts = maxAttempts;
  if (baseDelayMs !== undefined) r.baseDelayMs = baseDelayMs;
  if (maxDelayMs !== undefined) r.maxDelayMs = maxDelayMs;
  return r;
}

export function buildAdvancedCount(input: {
  systemPrompt: string;
  allowedTools: string;
  maxLoops: number;
  timeoutMs: number;
  toolRetryMaxAttempts: string;
  toolRetryBaseDelayMs: string;
  toolRetryMaxDelayMs: string;
  temperature: string;
  topP: string;
  maxTokens: string;
  presencePenalty: string;
  frequencyPenalty: string;
}): number {
  let n = 0;
  if (input.systemPrompt.trim()) n++;
  if (input.allowedTools.trim()) n++;
  if (input.maxLoops !== 20) n++;  // default from infra/config.ts
  if (input.timeoutMs !== 120_000) n++;
  if (input.toolRetryMaxAttempts.trim()) n++;
  if (input.toolRetryBaseDelayMs.trim()) n++;
  if (input.toolRetryMaxDelayMs.trim()) n++;
  if (input.temperature.trim()) n++;
  if (input.topP.trim()) n++;
  if (input.maxTokens.trim()) n++;
  if (input.presencePenalty.trim()) n++;
  if (input.frequencyPenalty.trim()) n++;
  return n;
}

export function buildTodoPrompt(todo: TodoItem): string {
  const lines = [
    `处理 Todo: ${todo.title}`,
    '',
    todo.description ? todo.description : 'No description provided.',
    '',
    `Todo id: ${todo.id}`,
    `Status: ${todo.status}`,
    `Kind: ${todo.kind}`,
    `Priority: ${todo.priority}`,
    `Stage: ${todo.stageId ?? 'none'}`,
  ];
  if (todo.dependsOnIds.length > 0) lines.push(`Depends on: ${todo.dependsOnIds.join(', ')}`);
  return lines.join('\n');
}

export function readRunContract(todo: TodoItem | null): Record<string, unknown> | undefined {
  const value = todo?.metadata?.runContract;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function intOrUndef(v: string): number | undefined {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) ? n : undefined;
}

export function buildHistoryRows(
  messages: Array<Record<string, unknown>>,
  turns: Array<Record<string, unknown>>,
): StreamRow[] {
  const rows: StreamRow[] = [];
  let turnIdx = 0;
  for (const msg of messages) {
    const role = String(msg.role ?? '');
    if (role === 'system') continue;
    if (role === 'user') {
      const content = String(msg.content ?? '');
      rows.push({ id: crypto.randomUUID(), event: 'user', message: content.length > 400 ? content.slice(0, 400) + '…' : content, level: 'normal' });
    } else if (role === 'assistant') {
      const toolCalls = Array.isArray(msg.tool_calls) ? (msg.tool_calls as Array<Record<string, unknown>>) : [];
      const toolNames = toolCalls.map(tc => String((tc.function as Record<string, unknown> | undefined)?.name ?? '')).filter(Boolean);
      const text = String(msg.content ?? '');
      const turn = turns[turnIdx] as Record<string, unknown> | undefined;
      const hasReasoning = turn?.reasoningContent && typeof turn.reasoningContent === 'string' && turn.reasoningContent.length > 0;
      const metaParts: string[] = [];
      if (toolNames.length > 0) metaParts.push(`tools: ${toolNames.join(', ')}`);
      if (hasReasoning) metaParts.push('🧠');
      rows.push({
        id: crypto.randomUUID(), event: `T${turnIdx + 1}/${turns.length}`,
        message: text.length > 250 ? text.slice(0, 250) + '…' : (text || (toolNames.length > 0 ? '(tool calls only)' : '(empty)')),
        meta: metaParts.length > 0 ? metaParts.join(' · ') : undefined,
        level: toolNames.length > 0 ? 'warn' : 'ok',
      });
      turnIdx++;
    } else if (role === 'tool') {
      const content = String(msg.content ?? '');
      const lastRow = rows[rows.length - 1];
      if (lastRow && lastRow.event.startsWith('T')) {
        const summary = content.length > 150 ? content.slice(0, 150) + '…' : content;
        lastRow.meta = lastRow.meta ? `${lastRow.meta} → ${summary}` : summary;
      }
    }
  }
  rows.push({ id: crypto.randomUUID(), event: 'history.end', message: `${rows.length} prior messages shown. Send a prompt to continue.`, meta: `${turnIdx} turns in history`, level: 'ok' });
  return rows;
}

export function appendLiveSessionEvent(
  prev: SessionEventsResponse | undefined, sessionId: string, event: SessionEvent,
): SessionEventsResponse {
  if (!prev) return { sessionId, count: 1, events: [event] };
  const existingIndex = prev.events.findIndex(item => item.id === event.id);
  const events = existingIndex >= 0
    ? prev.events.map(item => item.id === event.id ? event : item)
    : [...prev.events, event];
  events.sort((a, b) => a.id - b.id);
  return { ...prev, events: events.slice(-200), count: existingIndex >= 0 ? prev.count : prev.count + 1 };
}

export function streamRow(event: string, data: Record<string, unknown>): StreamRow {
  if (event === 'done') return { id: crypto.randomUUID(), event, message: typeof data.text === 'string' ? data.text : 'Run completed.', meta: data.sessionId ? `session ${data.sessionId}` : undefined, level: 'ok' };
  if (event === 'error') return { id: crypto.randomUUID(), event, message: String(data.message ?? 'stream error'), level: 'error' };
  if (event === 'session.resumed') {
    const tps = Array.isArray(data.turnPreviews) ? (data.turnPreviews as Array<Record<string, unknown>>) : [];
    const lines = tps.slice(0, 8).map(tp => {
      return `T${tp.loop ?? '?'}: ${String(tp.text ?? '').slice(0, 60)}${Array.isArray(tp.tools) && (tp.tools as string[]).length ? ` [${(tp.tools as string[]).join(',')}]` : ''}`;
    });
    const more = tps.length > 8 ? ` (+${tps.length - 8} more)` : '';
    return { id: crypto.randomUUID(), event, message: `Resumed session (${data.turnCount ?? '?'} turns, ${data.messageCount ?? '?'} msgs)`, meta: lines.length > 0 ? lines.join(' | ') + more : `last task ${String(data.resumeLastTaskRunId ?? 'none')}`, level: 'ok' };
  }
  if (event === 'session.branch') return { id: crypto.randomUUID(), event: 'branch', message: String(data.message ?? data), level: 'ok' };
  if (event === 'session.branched') return { id: crypto.randomUUID(), event, message: `Branched from ${String(data.parentSessionId ?? 'unknown')}${data.branchAtTurn ? ` at turn ${data.branchAtTurn}` : ''}`, meta: `${data.copiedMessageCount ?? data.messageCount ?? '?'} messages copied`, level: 'ok' };
  if (event === 'session.loading') return { id: crypto.randomUUID(), event: 'session', message: String(data.message ?? data), level: 'normal' };
  if (event === '---') return { id: crypto.randomUUID(), event, message: String(data.message ?? data), meta: String(data.meta ?? ''), level: 'normal' };
  if (event === 'history.end') return { id: crypto.randomUUID(), event: '---', message: String(data.message ?? data), meta: String(data.meta ?? ''), level: 'ok' };
  if (event === 'session.resume_state') return { id: crypto.randomUUID(), event, message: 'Loaded session resume state.', meta: JSON.stringify(data), level: 'normal' };
  if (event === 'model.delta') return { id: crypto.randomUUID(), event, message: String(data.text ?? data.delta ?? ''), meta: [data.provider, data.model].filter(Boolean).join(' / ') };
  if (event === 'turn') return { id: crypto.randomUUID(), event, message: String(data.text ?? 'model turn'), meta: `loop ${String(data.loopCount ?? '?')} · tools ${Array.isArray(data.toolNames) ? data.toolNames.join(', ') || 'none' : '?'}` };
  if (event === 'tool.call.upsert' || event === 'tool_call') {
    return {
      id: crypto.randomUUID(),
      event,
      message: String(data.toolName ?? data.tool ?? 'tool call'),
      meta: [data.callId, data.status, data.argsPreview].filter(Boolean).join(' · '),
      level: 'warn',
    };
  }
  if (event === 'task') return { id: crypto.randomUUID(), event, message: String(data.type ?? data.status ?? 'task event'), meta: [data.taskRunId, data.nodeId].filter(Boolean).join(' · '), level: String(data.status ?? '').includes('succeeded') ? 'ok' : 'normal' };
  return { id: crypto.randomUUID(), event, message: JSON.stringify(data) };
}

// ── Trace message mapping ──

import type { SessionTraceResponse } from './api';
import type { Message } from './chat-messages.js';

export function mapTraceToMessages(
  input: SessionTraceResponse['messages'],
  sessionId: string | null,
): Message[] {
  const sid = sessionId ?? 'no-session';
  return input.map((msg, idx) => ({
    id: `${sid}:${idx}:${msg.role}:${msg.turnIndex ?? ''}:${msg.eventType ?? ''}`,
    role: msg.role,
    content: msg.content,
    meta: msg.meta,
    level: msg.level,
    eventType: msg.eventType,
    provider: msg.provider,
    model: msg.model,
    turnIndex: msg.turnIndex,
    totalTurns: msg.totalTurns,
    reasoning: msg.reasoning,
    toolCalls: msg.toolCalls.map(tc => ({
      callId: tc.callId,
      toolName: tc.toolName,
      status: tc.status,
      argsPreview: tc.argsPreview,
      args: tc.args,
      resultPreview: tc.resultPreview,
      errorPreview: tc.errorPreview,
      durationMs: tc.durationMs,
      attempts: tc.attempts,
    })),
  }));
}
