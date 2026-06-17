/**
 * @los/agent/reflection — Post-execution reflection and recovery suggestion.
 *
 * Phase 4.4 Reflection闭环: analyzes self-check failures and DLQ events
 * to generate structured recovery suggestions. Closes the loop between
 * execution failure → analysis → recovery.
 */

import type { SelfCheckGap, SelfCheckResult } from './self-check.js';
import type { DeadLetterEventRecord } from './dead-letter.js';

export interface ReflectionResult {
  /** Overall assessment of what went wrong. */
  summary: string;
  /** Concrete suggested actions to recover or retry. */
  recoveryActions: string[];
  /** Whether the task is likely recoverable (retry) or needs operator attention. */
  recoveryType: 'retry' | 'escalate' | 'adjust_and_retry';
  /** The most relevant self-check gaps, if any. */
  relevantGaps: SelfCheckGap[];
  /** Matching DLQ events from past sessions with similar failures. */
  similarFailures: DeadLetterEventRecord[];
  /** When the reflection was generated. */
  reflectedAt: string;
}

/**
 * Analyze self-check gaps and DLQ events to produce a structured
 * reflection with recovery suggestions.
 */
export function reflectOnFailure(params: {
  selfCheck?: SelfCheckResult;
  dlqEvents?: DeadLetterEventRecord[];
}): ReflectionResult {
  const { selfCheck, dlqEvents = [] } = params;
  const gaps = selfCheck?.gaps ?? [];
  const recoveryActions: string[] = [];
  let recoveryType: ReflectionResult['recoveryType'] = 'escalate';

  // ── Gap analysis ──
  if (gaps.length === 0 && dlqEvents.length === 0) {
    return {
      summary: 'No specific failure patterns detected. Manual review recommended.',
      recoveryActions: ['Review the task output manually and re-run if appropriate.'],
      recoveryType: 'escalate',
      relevantGaps: [],
      similarFailures: [],
      reflectedAt: new Date().toISOString(),
    };
  }

  // Classify gaps and suggest recovery
  for (const gap of gaps) {
    if (gap.condition === 'output' || gap.condition === 'self_check_parse') {
      recoveryActions.push(`Output issue (${gap.condition}): ${gap.suggestion}`);
      recoveryType = 'adjust_and_retry';
    } else if (gap.condition === 'self_check_provider') {
      recoveryActions.push(`Provider error during self-check: ${gap.suggestion}`);
      recoveryType = 'retry';
    } else {
      recoveryActions.push(`Gap [${gap.condition}]: ${gap.detail} → ${gap.suggestion}`);
      recoveryType = recoveryType === 'retry' ? 'adjust_and_retry' : recoveryType;
    }
  }

  // ── DLQ pattern matching ──
  if (dlqEvents.length > 0) {
    const reasonCounts = new Map<string, number>();
    for (const ev of dlqEvents) {
      const key = ev.reason ?? 'unknown';
      reasonCounts.set(key, (reasonCounts.get(key) ?? 0) + 1);
    }
    const topReasons = [...reasonCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3);

    if (topReasons.length > 0) {
      recoveryActions.push(
        `Common failure reasons in past sessions: ${topReasons.map(([r, c]) => `${r} (${c}×)`).join(', ')}. ` +
        'Consider adjusting the task to avoid these patterns.',
      );
      if (topReasons.some(([r]) => r === 'lease_expired' || r === 'timeout')) {
        recoveryType = 'retry';
      }
    }
  }

  // Ensure at least one action
  if (recoveryActions.length === 0) {
    recoveryActions.push('Manual review required — no automated recovery path identified.');
  }

  const summary = gaps.length > 0
    ? `Self-check found ${gaps.length} gap(s). ${dlqEvents.length > 0 ? `Matched ${dlqEvents.length} similar past failure(s).` : ''}`
    : `${dlqEvents.length} similar past failure(s) found. No self-check gaps.`;

  return {
    summary,
    recoveryActions,
    recoveryType,
    relevantGaps: gaps,
    similarFailures: dlqEvents,
    reflectedAt: new Date().toISOString(),
  };
}

/**
 * Format reflection into a human-readable summary suitable for
 * session events, todo descriptions, or operator notifications.
 */
export function formatReflectionSummary(reflection: ReflectionResult): string {
  const lines = [
    `## Reflection`,
    '',
    reflection.summary,
    '',
    '### Recovery Type',
    reflection.recoveryType,
    '',
    '### Suggested Actions',
    ...reflection.recoveryActions.map((a, i) => `${i + 1}. ${a}`),
  ];

  if (reflection.relevantGaps.length > 0) {
    lines.push('', '### Self-Check Gaps');
    for (const gap of reflection.relevantGaps) {
      lines.push(`- [${gap.condition}] ${gap.detail}`);
    }
  }

  return lines.join('\n');
}
