/**
 * Operator-visible governance notifications.
 *
 * Turns GA loop / self-bootstrap outcomes into session_events that the
 * operator SSE stream and channel bots (WeChat/Telegram) can deliver.
 * Events are best-effort — notification failure must never abort a sweep.
 */

import { getLogger } from '@los/infra/logger';
import { appendSessionEvent } from './session-events.js';

const log = getLogger('governance-notify');

/** Stable synthetic session for governance-originated operator events. */
export const GOVERNANCE_NOTIFY_SESSION_ID = 'governance:system';

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

/**
 * Map notification kind to session event type consumed by operator SSE + bots.
 */
export function governanceNotifyEventType(kind: GovernanceNotifyKind): string {
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
  const type = governanceNotifyEventType(input.kind);
  const severity = input.severity ?? (input.kind === 'escalation' ? 'warning' : 'info');
  try {
    await appendSessionEvent({
      sessionId,
      type,
      source: 'governance',
      // governance.* defaults to audit visibility via sessionEventVisibility()
      payload: {
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
      },
    });
  } catch (err) {
    log.warn(
      `governance notify failed [${input.kind}/${input.jobType}]: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
