/**
 * Operator-visible governance notifications.
 *
 * Turns GA loop / self-bootstrap outcomes into session_events that the
 * operator SSE stream and channel bots (WeChat/Telegram) can deliver.
 * Events are best-effort — notification failure must never abort a sweep.
 */

import { getLogger } from '@los/infra/logger';
import { appendSessionEvent } from './session-events.js';
import { enqueueDshEvent } from './dsh-event-outbox.js';

const log = getLogger('governance-notify');

/** Stable synthetic session for governance-originated operator events. */
const GOVERNANCE_NOTIFY_SESSION_ID = 'governance:system';

export type GovernanceNotifyKind =
  | 'escalation'
  | 'progress'
  | 'bootstrap_finding'
  | 'sweep_digest';

export type GovernanceNotifySeverity = 'info' | 'warning' | 'critical';

export interface GovernanceNotifyInput {
  sessionId?: string;
  jobType: string;
  jobId?: string;
  kind: GovernanceNotifyKind;
  severity?: GovernanceNotifySeverity;
  title: string;
  detail: string;
  findingCount?: number;
  /** Extra non-secret fields for UI / bots. */
  extra?: Record<string, unknown>;
}

/** Map notification kind to session event type consumed by operator SSE + bots. */
function eventTypeForKind(kind: GovernanceNotifyKind): string {
  switch (kind) {
    case 'escalation':
      return 'governance.job.escalated';
    case 'bootstrap_finding':
      return 'governance.bootstrap.findings';
    case 'sweep_digest':
      return 'governance.sweep.digest';
    case 'progress':
    default:
      return 'governance.job.progress';
  }
}

export async function emitGovernanceOperatorNotify(
  input: GovernanceNotifyInput,
): Promise<void> {
  const sessionId = input.sessionId?.trim() || GOVERNANCE_NOTIFY_SESSION_ID;
  const type = eventTypeForKind(input.kind);
  const severity = input.severity ?? (input.kind === 'escalation' ? 'warning' : 'info');
  const payload = {
    kind: input.kind,
    severity,
    title: input.title,
    detail: input.detail,
    reason: input.detail,
    jobType: input.jobType,
    jobId: input.jobId ?? null,
    findingCount: input.findingCount ?? null,
    requiresDecision: input.kind === 'escalation',
    ...(input.extra ?? {}),
  };
  try {
    await appendSessionEvent({
      sessionId,
      type,
      source: 'governance',
      // governance.* defaults to audit visibility via sessionEventVisibility()
      payload,
    });
  } catch (err) {
    log.warn(
      `governance notify failed [${input.kind}/${input.jobType}]: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  // los → DSH 事件面（P1-a）：同一个通知也入队一条 DSH 事件（持久重试，见 dsh-event-outbox.ts）。
  // 这是**唯一**的治理通知出口 —— 在 SSE/渠道之外再挂一条到 DSH，不必在每个 emitter 里重复埋点。
  // 入队失败不影响通知本身（best-effort，与上面的 appendSessionEvent 同语义）。
  try {
    await enqueueDshEvent({
      eventId: `${type}:${input.jobType}:${input.jobId ?? 'no-job'}:${Date.now()}`,
      type,
      sessionId,
      payload,
    });
  } catch (err) {
    log.warn(
      `dsh event enqueue failed [${input.kind}/${input.jobType}]: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
