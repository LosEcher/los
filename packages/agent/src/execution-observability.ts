import { createHash } from 'node:crypto';

import type { SessionEventRecord, SessionEventUsage } from './session-events.js';
import type { VerificationRecord } from './verification-records.js';

export type ExecutionFingerprintComponentName = 'prompt' | 'spec' | 'memory' | 'toolCatalog';

export interface ExecutionVersionEvidence {
  status: 'known' | 'unknown';
  value: string | null;
  eventIds: number[];
}

export interface ExecutionFingerprint {
  status: 'known' | 'unknown';
  algorithm: 'sha256';
  hash: string | null;
  components: Record<ExecutionFingerprintComponentName, ExecutionVersionEvidence>;
}

export interface ExecutionDurationEvidence {
  durationMs: number;
  eventIds: number[];
}

export interface ExecutionCountEvidence {
  count: number;
  eventIds: number[];
}

export interface ExecutionTokenEvidence extends SessionEventUsage {
  eventIds: number[];
}

export interface ExecutionTurnWaterfall {
  turn: number;
  modelWait: ExecutionDurationEvidence;
  toolWait: ExecutionDurationEvidence;
  retries: ExecutionCountEvidence;
  errors: ExecutionCountEvidence;
  denied: ExecutionCountEvidence;
  tokens: ExecutionTokenEvidence;
}

export type ExecutionFailureFacetCategory =
  | 'provider'
  | 'tool'
  | 'policy'
  | 'verification'
  | 'context'
  | 'recovery';

export interface ExecutionFailureFacet {
  category: ExecutionFailureFacetCategory;
  code: string;
  message: string | null;
  eventIds: number[];
  verificationRecordIds: string[];
}

export interface ExecutionObservabilityProjection {
  sessionId: string;
  fingerprint: ExecutionFingerprint;
  waterfall: ExecutionTurnWaterfall[];
  failureFacets: ExecutionFailureFacet[];
}

const VERSION_SOURCES: Array<{
  component: ExecutionFingerprintComponentName;
  eventType: string;
  fields: string[];
}> = [
  { component: 'prompt', eventType: 'session.started', fields: ['promptVersion', 'promptHash'] },
  { component: 'spec', eventType: 'coordinator.context_policy_selected', fields: ['specVersion', 'specHash'] },
  { component: 'memory', eventType: 'coordinator.context_policy_selected', fields: ['memoryVersion', 'memoryHash'] },
  { component: 'toolCatalog', eventType: 'tool.catalog', fields: ['catalogVersion', 'catalogHash'] },
];

const EMPTY_USAGE: SessionEventUsage = {
  promptTokens: 0,
  completionTokens: 0,
  cacheHitTokens: 0,
  cacheMissTokens: 0,
  totalTokens: 0,
};

export function projectExecutionObservability(
  sessionId: string,
  events: readonly SessionEventRecord[],
  verificationRecords: readonly VerificationRecord[] = [],
): ExecutionObservabilityProjection {
  return {
    sessionId,
    fingerprint: projectFingerprint(events),
    waterfall: projectWaterfall(events),
    failureFacets: projectFailureFacets(events, verificationRecords),
  };
}

function projectFingerprint(events: readonly SessionEventRecord[]): ExecutionFingerprint {
  const components = Object.fromEntries(VERSION_SOURCES.map(source => [
    source.component,
    findVersionEvidence(events, source.eventType, source.fields),
  ])) as Record<ExecutionFingerprintComponentName, ExecutionVersionEvidence>;
  const status = Object.values(components).every(component => component.status === 'known')
    ? 'known'
    : 'unknown';
  const hash = status === 'known'
    ? createHash('sha256').update(JSON.stringify({
        prompt: components.prompt.value,
        spec: components.spec.value,
        memory: components.memory.value,
        toolCatalog: components.toolCatalog.value,
      })).digest('hex')
    : null;
  return { status, algorithm: 'sha256', hash, components };
}

function findVersionEvidence(
  events: readonly SessionEventRecord[],
  eventType: string,
  fields: readonly string[],
): ExecutionVersionEvidence {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!;
    if (event.type !== eventType) continue;
    for (const field of fields) {
      const value = optionalString(event.payload[field]);
      if (value) return { status: 'known', value, eventIds: [event.id] };
    }
  }
  return { status: 'unknown', value: null, eventIds: [] };
}

function projectWaterfall(events: readonly SessionEventRecord[]): ExecutionTurnWaterfall[] {
  const turns = new Set(events.filter(event => event.turn > 0).map(event => event.turn));
  return [...turns].sort((left, right) => left - right).map(turn => {
    const turnEvents = events.filter(event => event.turn === turn);
    const modelEvents = turnEvents.filter(event => event.type === 'model.response');
    const toolEvents = turnEvents.filter(event => event.type === 'tool.result');
    const explicitRetryEvents = turnEvents.filter(event => isRetryEvent(event.type));
    const attemptRetryCount = toolEvents.reduce((sum, event) => {
      const attempts = nonNegativeInteger(event.payload.attempts);
      return sum + Math.max(0, attempts - 1);
    }, 0);
    const errorEvents = turnEvents.filter(isErrorEvent);
    const deniedEvents = uniqueDeniedEvents(turnEvents);
    const usage = modelEvents.reduce((total, event) => addUsage(total, event.usage), { ...EMPTY_USAGE });

    return {
      turn,
      modelWait: {
        durationMs: sumDuration(modelEvents),
        eventIds: modelEvents.map(event => event.id),
      },
      toolWait: {
        durationMs: sumDuration(toolEvents),
        eventIds: toolEvents.map(event => event.id),
      },
      retries: {
        count: Math.max(explicitRetryEvents.length, attemptRetryCount),
        eventIds: uniqueNumbers([
          ...explicitRetryEvents.map(event => event.id),
          ...toolEvents.filter(event => nonNegativeInteger(event.payload.attempts) > 1).map(event => event.id),
        ]),
      },
      errors: {
        count: errorEvents.length,
        eventIds: errorEvents.map(event => event.id),
      },
      denied: {
        count: deniedEvents.length,
        eventIds: deniedEvents.map(event => event.id),
      },
      tokens: {
        ...usage,
        eventIds: modelEvents.filter(event => event.usage !== undefined).map(event => event.id),
      },
    };
  });
}

function projectFailureFacets(
  events: readonly SessionEventRecord[],
  verificationRecords: readonly VerificationRecord[],
): ExecutionFailureFacet[] {
  const facets: ExecutionFailureFacet[] = [];
  for (const event of events) {
    if (isProviderFailure(event)) {
      facets.push(eventFacet('provider', 'provider_error', event));
    }
    if (event.type === 'tool.result' && event.payload.ok === false && event.payload.denied !== true) {
      facets.push(eventFacet('tool', 'tool_error', event));
    }
    if (event.type === 'tool.denied' || (event.type === 'tool.result' && event.payload.denied === true)) {
      facets.push(eventFacet('policy', 'tool_denied', event));
    }
    if (event.type === 'context.fill.critical') {
      facets.push(eventFacet('context', 'context_fill_critical', event));
    }
    if (event.type.includes('recovery')) {
      facets.push(eventFacet('recovery', event.type, event));
    }
  }
  for (const record of verificationRecords) {
    if (record.status !== 'failed') continue;
    facets.push({
      category: 'verification',
      code: 'verification_failed',
      message: record.error ?? record.outputSummary ?? record.checkName,
      eventIds: [],
      verificationRecordIds: [record.id],
    });
  }
  return facets;
}

function eventFacet(
  category: ExecutionFailureFacetCategory,
  fallbackCode: string,
  event: SessionEventRecord,
): ExecutionFailureFacet {
  return {
    category,
    code: optionalString(event.payload.code) ?? fallbackCode,
    message: optionalString(event.payload.message)
      ?? optionalString(event.payload.reason)
      ?? optionalString(event.payload.errorPreview)
      ?? null,
    eventIds: [event.id],
    verificationRecordIds: [],
  };
}

function isProviderFailure(event: SessionEventRecord): boolean {
  if (event.type === 'model.error' || event.type === 'provider.error') return true;
  return event.type === 'session.error'
    && (event.payload.category === 'provider' || optionalString(event.payload.provider) !== undefined);
}

function isErrorEvent(event: SessionEventRecord): boolean {
  if (event.type === 'tool.result') return event.payload.ok === false && event.payload.denied !== true;
  return event.type === 'model.error' || event.type === 'provider.error'
    || event.type === 'session.error' || event.type === 'task.failed';
}

function isRetryEvent(type: string): boolean {
  return type === 'tool.retrying' || type === 'tool_call_state.retrying';
}

function uniqueDeniedEvents(events: readonly SessionEventRecord[]): SessionEventRecord[] {
  const seen = new Set<string>();
  const out: SessionEventRecord[] = [];
  for (const event of events) {
    if (event.type !== 'tool.denied' && !(event.type === 'tool.result' && event.payload.denied === true)) continue;
    const callId = optionalString(event.payload.callId);
    const key = callId ? `call:${callId}` : `event:${event.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(event);
  }
  return out;
}

function sumDuration(events: readonly SessionEventRecord[]): number {
  return events.reduce((sum, event) => sum + nonNegativeInteger(event.payload.durationMs), 0);
}

function addUsage(total: SessionEventUsage, usage: SessionEventUsage | undefined): SessionEventUsage {
  if (!usage) return total;
  return {
    promptTokens: total.promptTokens + usage.promptTokens,
    completionTokens: total.completionTokens + usage.completionTokens,
    cacheHitTokens: total.cacheHitTokens + usage.cacheHitTokens,
    cacheMissTokens: total.cacheMissTokens + usage.cacheMissTokens,
    totalTokens: total.totalTokens + usage.totalTokens,
  };
}

function optionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  return normalized || undefined;
}

function nonNegativeInteger(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return 0;
  return Math.floor(value);
}

function uniqueNumbers(values: readonly number[]): number[] {
  return [...new Set(values)];
}
