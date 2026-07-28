/**
 * @los/agent/loop/agent-lifecycle — Context monitor + checkpoint resume setup.
 *
 * Extracted from loop.ts to keep runAgent under the 600-line CI gate.
 */
import { createContextMonitor, formatContextFill } from '../context-monitor.js';
import type { AgentConfig, TurnSummary } from './types.js';
import type { Message } from '../providers/index.js';
import type { PersistedToolResultEvidence } from '../semantic-eviction.js';
import type { Logger } from '@los/infra/logger';

type EmitEvent = (event: { type: string; turn?: number; payload?: Record<string, unknown> }) => unknown;

export function setupContextMonitor(
  config: AgentConfig,
  messages: Message[],
  emitEvent: EmitEvent,
  applyCriticalEviction: (fillPercent: number) => void,
  persistedToolResults: Map<string, PersistedToolResultEvidence>,
  agentLog: Logger,
) {
  if (!config.contextMonitor) return null;
  return createContextMonitor({
    contextWindowTokens: config.contextMonitor.contextWindowTokens ?? 200_000,
    warnThreshold: config.contextMonitor.warnThreshold ?? 0.60,
    checkpointThreshold: config.contextMonitor.checkpointThreshold ?? 0.75,
    criticalThreshold: config.contextMonitor.criticalThreshold ?? 0.85,
    onWarn: (s) => {
      agentLog.warn(formatContextFill(s));
      config.contextMonitor?.onWarn?.({ fillPercent: s.fillPercent, usedTokens: s.usedTokens, turn: s.turn });
      emitEvent({ type: 'context.fill.warn', turn: s.turn, payload: { fillPercent: s.fillPercent, usedTokens: s.usedTokens, contextWindowTokens: s.contextWindowTokens } });
    },
    onCheckpoint: (s) => {
      agentLog.info(formatContextFill(s));
      config.contextMonitor?.onCheckpoint?.({ fillPercent: s.fillPercent, usedTokens: s.usedTokens, turn: s.turn });
      emitEvent({ type: 'context.fill.checkpoint', turn: s.turn, payload: { fillPercent: s.fillPercent, usedTokens: s.usedTokens, contextWindowTokens: s.contextWindowTokens } });
    },
    onCritical: (s) => {
      agentLog.warn(formatContextFill(s));
      config.contextMonitor?.onCritical?.({ fillPercent: s.fillPercent, usedTokens: s.usedTokens, turn: s.turn });
      emitEvent({ type: 'context.fill.critical', turn: s.turn, payload: { fillPercent: s.fillPercent, usedTokens: s.usedTokens, contextWindowTokens: s.contextWindowTokens } });
      applyCriticalEviction(s.fillPercent);
    },
  });
}

export function restoreCheckpointState(
  config: AgentConfig,
  messages: Message[],
  agentLog: Logger,
): { turns: TurnSummary[]; isResume: boolean } {
  const isResume = config.resumeState !== undefined;
  if (isResume) config.skipPreExecutionPhases = true;
  const turns: TurnSummary[] = [];
  if (isResume && config.resumeState) {
    messages.length = 0;
    messages.push(...config.resumeState.messages);
    turns.push(...config.resumeState.turns);
    agentLog.info(`Resuming from checkpoint: ${turns.length} turns, ${messages.length} messages`);
  }
  return { turns, isResume };
}
