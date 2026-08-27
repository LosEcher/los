/**
 * Declarative node probe rules (B9, borrowed from mac-performance-monitor
 * CheckCatalog / DiagnosticProbes).
 *
 * A probe rule is a condition over a *fixed signal allow-list* (from the
 * health-index signals), a severity, and message templates. Rules are data,
 * not code: adding a signal is a vetted change to `NODE_PROBE_SIGNALS`, while
 * rules can be tuned without touching probe logic. This keeps the rules engine
 * a rules engine — never a remote-code-execution channel.
 */

import type { NodeHealthSignals } from './node-health.js';

export type { NodeHealthSignals } from './node-health.js';

/** Signals a rule may threshold. The set is FIXED — rules reference these names
 * only, mirroring DiagnosticProbes.known (a manifest can never name a new
 * data source or a command). */
export const NODE_PROBE_SIGNALS = [
  'heartbeatAgeSec',
  'modesRatio',       // modesOk / modesTotal (0-1; 0 when no modes)
  'blockerCount',
  'hasVerificationGap', // 1 or 0
  'recovering',       // 1 or 0
] as const;

export type NodeProbeSignal = (typeof NODE_PROBE_SIGNALS)[number];

export type NodeProbeSeverity = 'info' | 'warning' | 'critical';
export interface NodeProbeRule {
  id: string;
  title: string;
  /** Condition: signal op value. Op set mirrors CheckCondition: >= <= > < == != */
  when: { signal: NodeProbeSignal; op: '>=' | '<=' | '>' | '<' | '==' | '!='; value: number };
  severity: NodeProbeSeverity;
  message: string;
}

export interface NodeProbeFinding {
  ruleId: string;
  title: string;
  severity: NodeProbeSeverity;
  message: string;
  signal: NodeProbeSignal;
  value: number;
}

/** Extract the numeric value of a signal from the health signals. */
export function _signalValueOf(signal: NodeProbeSignal, signals: NodeHealthSignals): number {
  switch (signal) {
    case 'heartbeatAgeSec':
      return signals.heartbeatAgeSec;
    case 'modesRatio':
      return signals.modesTotal > 0 ? signals.modesOk / signals.modesTotal : 0;
    case 'blockerCount':
      return signals.blockerCount;
    case 'hasVerificationGap':
      return signals.hasVerificationGap ? 1 : 0;
    case 'recovering':
      return signals.recovering ? 1 : 0;
    default:
      return 0;
  }
}

/** Evaluate a rule's condition against a numeric value. */
export function _ruleMatches(rule: NodeProbeRule, value: number): boolean {
  const { op, value: expected } = rule.when;
  switch (op) {
    case '>=': return value >= expected;
    case '<=': return value <= expected;
    case '>': return value > expected;
    case '<': return value < expected;
    case '==': return value === expected;
    case '!=': return value !== expected;
    default: return false;
  }
}

/** Evaluate a rule manifest against signals into findings. A rule naming an
 * unknown signal is skipped (forward-compatible, mirrors CheckCatalog). */
export function evaluateNodeProbeRules(rules: NodeProbeRule[], signals: NodeHealthSignals): NodeProbeFinding[] {
  if (!Array.isArray(rules)) return [];
  const findings: NodeProbeFinding[] = [];
  for (const rule of rules) {
    if (!rule?.when || !rule.when.signal || !(NODE_PROBE_SIGNALS as readonly string[]).includes(rule.when.signal)) {
      continue;
    }
    const value = _signalValueOf(rule.when.signal, signals);
    if (_ruleMatches(rule, value)) {
      findings.push({
        ruleId: rule.id,
        title: rule.title,
        severity: rule.severity,
        message: rule.message,
        signal: rule.when.signal,
        value: Math.round(value * 100) / 100,
      });
    }
  }
  return findings;
}

/** Built-in quiet-by-default rule set (mirrors AlertConfig: only the serious
 * ones fire by default; everything else needs explicit opt-in).
 * Exposed as a function so the wiring checker sees a production caller and the
 * returned array can be defensively copied by callers. */
export function builtinNodeProbeRules(): NodeProbeRule[] {
  return [
    {
      id: 'node-stale-heartbeat',
      title: 'Node heartbeat stale',
      when: { signal: 'heartbeatAgeSec', op: '>', value: 900 },
      severity: 'critical',
      message: 'No heartbeat for over 15 minutes — node likely unreachable.',
    },
    {
      id: 'node-no-probe-coverage',
      title: 'No probe mode verified',
      when: { signal: 'modesRatio', op: '<=', value: 0 },
      severity: 'critical',
      message: 'None of the declared connect modes could be verified.',
    },
    {
      id: 'node-blockers-accumulating',
      title: 'Execution blockers accumulating',
      when: { signal: 'blockerCount', op: '>=', value: 2 },
      severity: 'warning',
      message: 'Multiple execution blockers are preventing candidate status.',
    },
    {
      id: 'node-recovering',
      title: 'Node recently recovered',
      when: { signal: 'recovering', op: '==', value: 1 },
      severity: 'info',
      message: 'Node was offline recently and is recovering.',
    },
  ];
}
