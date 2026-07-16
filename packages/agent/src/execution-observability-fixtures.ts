import type { SessionEventRecord, SessionEventUsage } from './session-events.js';
import type { VerificationRecord } from './verification-records.js';

export interface ExecutionObservabilityGoldenSnapshot {
  fingerprint: {
    status: 'known' | 'unknown';
    hash: string | null;
    components: Record<'prompt' | 'spec' | 'memory' | 'toolCatalog', 'known' | 'unknown'>;
  };
  waterfall: Array<{
    turn: number;
    modelWaitMs: number;
    toolWaitMs: number;
    retries: number;
    errors: number;
    denied: number;
    totalTokens: number;
    eventIds: number[];
  }>;
  failureFacets: Array<{
    category: string;
    code: string;
    eventIds: number[];
    verificationRecordIds: string[];
  }>;
}

export interface ExecutionObservabilityGoldenFixture {
  name: 'success' | 'provider_error' | 'tool_denied' | 'verification_failed' | 'recovery';
  sessionId: string;
  events: SessionEventRecord[];
  verificationRecords: VerificationRecord[];
  expected: ExecutionObservabilityGoldenSnapshot;
}

const SUCCESS_SESSION_ID = 'execution-observability-success';
const PROVIDER_ERROR_SESSION_ID = 'execution-observability-provider-error';
const TOOL_DENIED_SESSION_ID = 'execution-observability-tool-denied';
const VERIFICATION_FAILED_SESSION_ID = 'execution-observability-verification-failed';
const RECOVERY_SESSION_ID = 'execution-observability-recovery';

export const GOLDEN_EXECUTION_OBSERVABILITY_FIXTURES: ExecutionObservabilityGoldenFixture[] = [
  {
    name: 'success',
    sessionId: SUCCESS_SESSION_ID,
    events: [
      event(1, SUCCESS_SESSION_ID, 'session.started', 0, { promptVersion: 'prompt-v1' }),
      event(2, SUCCESS_SESSION_ID, 'coordinator.context_policy_selected', 0, {
        specVersion: 'spec-v2',
        memoryVersion: 'memory-v3',
      }),
      event(3, SUCCESS_SESSION_ID, 'tool.catalog', 0, { catalogVersion: 'tools-v4' }),
      event(4, SUCCESS_SESSION_ID, 'model.response', 1, { durationMs: 120 }, usage(10, 5, 2, 3)),
      event(5, SUCCESS_SESSION_ID, 'tool.result', 1, {
        callId: 'call-success',
        ok: true,
        durationMs: 30,
        attempts: 1,
      }),
    ],
    verificationRecords: [],
    expected: {
      fingerprint: {
        status: 'known',
        hash: '67086247203fd7a61128d8148071823d77e0ced3650ad60778c44397c8c5fdcb',
        components: { prompt: 'known', spec: 'known', memory: 'known', toolCatalog: 'known' },
      },
      waterfall: [{
        turn: 1,
        modelWaitMs: 120,
        toolWaitMs: 30,
        retries: 0,
        errors: 0,
        denied: 0,
        totalTokens: 15,
        eventIds: [4, 5],
      }],
      failureFacets: [],
    },
  },
  {
    name: 'provider_error',
    sessionId: PROVIDER_ERROR_SESSION_ID,
    events: [event(1, PROVIDER_ERROR_SESSION_ID, 'session.error', 1, {
      category: 'provider',
      provider: 'deepseek',
      code: 'rate_limited',
      message: 'provider rejected the request',
    })],
    verificationRecords: [],
    expected: {
      fingerprint: unknownFingerprint(),
      waterfall: [{
        turn: 1,
        modelWaitMs: 0,
        toolWaitMs: 0,
        retries: 0,
        errors: 1,
        denied: 0,
        totalTokens: 0,
        eventIds: [1],
      }],
      failureFacets: [{
        category: 'provider',
        code: 'rate_limited',
        eventIds: [1],
        verificationRecordIds: [],
      }],
    },
  },
  {
    name: 'tool_denied',
    sessionId: TOOL_DENIED_SESSION_ID,
    events: [event(1, TOOL_DENIED_SESSION_ID, 'tool.denied', 1, {
      callId: 'call-denied',
      reason: 'project-write tool is disabled',
    })],
    verificationRecords: [],
    expected: {
      fingerprint: unknownFingerprint(),
      waterfall: [{
        turn: 1,
        modelWaitMs: 0,
        toolWaitMs: 0,
        retries: 0,
        errors: 0,
        denied: 1,
        totalTokens: 0,
        eventIds: [1],
      }],
      failureFacets: [{
        category: 'policy',
        code: 'tool_denied',
        eventIds: [1],
        verificationRecordIds: [],
      }],
    },
  },
  {
    name: 'verification_failed',
    sessionId: VERIFICATION_FAILED_SESSION_ID,
    events: [],
    verificationRecords: [verification(VERIFICATION_FAILED_SESSION_ID)],
    expected: {
      fingerprint: unknownFingerprint(),
      waterfall: [],
      failureFacets: [{
        category: 'verification',
        code: 'verification_failed',
        eventIds: [],
        verificationRecordIds: ['verification-golden-failed'],
      }],
    },
  },
  {
    name: 'recovery',
    sessionId: RECOVERY_SESSION_ID,
    events: [
      event(1, RECOVERY_SESSION_ID, 'model.response', 1, { durationMs: 50 }, usage(8, 2, 0, 0)),
      event(2, RECOVERY_SESSION_ID, 'tool_call_state.retrying', 1, { callId: 'call-retry' }),
      event(3, RECOVERY_SESSION_ID, 'context.fill.critical', 1, { fillPercent: 0.9 }),
      event(4, RECOVERY_SESSION_ID, 'run.recovery_required', 1, {
        code: 'tool_resume_required',
        recommendation: 'resume',
      }),
    ],
    verificationRecords: [],
    expected: {
      fingerprint: unknownFingerprint(),
      waterfall: [{
        turn: 1,
        modelWaitMs: 50,
        toolWaitMs: 0,
        retries: 1,
        errors: 0,
        denied: 0,
        totalTokens: 10,
        eventIds: [1, 2],
      }],
      failureFacets: [
        { category: 'context', code: 'context_fill_critical', eventIds: [3], verificationRecordIds: [] },
        { category: 'recovery', code: 'tool_resume_required', eventIds: [4], verificationRecordIds: [] },
      ],
    },
  },
];

function event(
  id: number,
  sessionId: string,
  type: string,
  turn: number,
  payload: Record<string, unknown>,
  eventUsage?: SessionEventUsage,
): SessionEventRecord {
  return {
    id,
    sessionId,
    turn,
    type,
    source: 'golden-fixture',
    usage: eventUsage,
    payload,
    visibility: 'audit',
    createdAt: `2026-07-16T00:00:${String(id).padStart(2, '0')}.000Z`,
  };
}

function usage(promptTokens: number, completionTokens: number, cacheHitTokens: number, cacheMissTokens: number): SessionEventUsage {
  return {
    promptTokens,
    completionTokens,
    cacheHitTokens,
    cacheMissTokens,
    totalTokens: promptTokens + completionTokens,
  };
}

function verification(sessionId: string): VerificationRecord {
  return {
    id: 'verification-golden-failed',
    sessionId,
    runSpecId: 'run-golden-failed',
    checkName: 'pnpm check',
    kind: 'command',
    command: 'pnpm check',
    planRevision: 1,
    status: 'failed',
    required: true,
    error: 'typecheck failed',
    createdAt: '2026-07-16T00:00:00.000Z',
    updatedAt: '2026-07-16T00:00:01.000Z',
    completedAt: '2026-07-16T00:00:01.000Z',
  };
}

function unknownFingerprint(): ExecutionObservabilityGoldenSnapshot['fingerprint'] {
  return {
    status: 'unknown',
    hash: null,
    components: { prompt: 'unknown', spec: 'unknown', memory: 'unknown', toolCatalog: 'unknown' },
  };
}
