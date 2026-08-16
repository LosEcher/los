/**
 * @los/agent/scheduler/blocking-evidence — Evidence helpers for blocked runs.
 *
 * Turns raw session events into operator-readable signals about WHY a run
 * ended blocked, so the failure message surfaces the real blocker instead of
 * a misleading stop-condition mismatch (2026-08-17 NAS34 sing-box incident:
 * an agent blocked by tool policy + path denials ended with an unanswered
 * worker.ask, and the goal self-check reported "operator cancels schedule"
 * with no evidence).
 */

import type { SessionEventRecord } from '../session-events.js';

/** Event types that mark the agent as waiting on a coordinator/operator decision. */
const AWAITING_OPERATOR_EVENT_TYPES = new Set(['worker.ask', 'worker.escalation']);

export type BlockingEvidenceInput = Pick<SessionEventRecord, 'type' | 'toolName' | 'payload'>;

/** True when the run emitted an unanswered coordinator question (worker.ask /
 *  worker.escalation): the agent is blocked on a human decision, not on the goal. */
export function hasAwaitingOperatorEvidence(events: readonly BlockingEvidenceInput[]): boolean {
  return events.some(event => AWAITING_OPERATOR_EVENT_TYPES.has(event.type));
}

/**
 * Compact summary of tool.denied events, grouped by tool name with the first
 * denial reason. Returns '' when there is nothing to report.
 *
 * Example: `tool denials: run_shell×2 (Tool risk L2 exceeds max L1), read_file×1 (Path traversal denied)`
 */
export function summarizeToolDenials(
  events: readonly BlockingEvidenceInput[],
  maxTools = 5,
): string {
  const byTool = new Map<string, { count: number; reason: string }>();
  for (const event of events) {
    if (event.type !== 'tool.denied') continue;
    const tool = event.toolName ?? 'unknown';
    const reason = typeof event.payload?.reason === 'string'
      ? event.payload.reason
      : (typeof event.payload?.reasonCode === 'string' ? event.payload.reasonCode : 'denied');
    const entry = byTool.get(tool) ?? { count: 0, reason };
    entry.count += 1;
    byTool.set(tool, entry);
  }
  if (byTool.size === 0) return '';
  const parts = [...byTool.entries()]
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, maxTools)
    .map(([tool, { count, reason }]) => `${tool}×${count} (${reason})`);
  const total = [...byTool.values()].reduce((sum, item) => sum + item.count, 0);
  return `tool denials: ${parts.join(', ')}${total > 1 ? ` (${total} total)` : ''}`;
}
