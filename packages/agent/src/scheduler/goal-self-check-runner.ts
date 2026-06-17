import type { AgentResult } from '../loop.js';
import { createProvider } from '../providers/index.js';
import { runPostExecutionSelfCheck, shouldRunSelfCheck, summarizeAgentContext } from '../self-check.js';
import { readCurrentRunContract } from './contract-reader.js';
import { transitionExecutionState } from '../execution-store.js';
import { updateTaskRunFields } from '../task-runs.js';
import { emitTaskEvent } from './task-events.js';
import { getConfig } from '@los/infra/config';
import type { ScheduledAgentTaskInput, ScheduledAgentTaskResult } from './types.js';

/**
 * B0: Post-execution goal self-check gate.
 * Evaluates agent output against declared goal and stop conditions.
 * Uses an independent judge provider/model when configured (P0-2)
 * to avoid self-affirmation bias. Blocks the run if it doesn't pass.
 */
export async function runGoalSelfCheck(
  input: ScheduledAgentTaskInput,
  result: AgentResult,
  running: { metadata: Record<string, unknown> },
  sessionId: string,
  taskRunId: string,
): Promise<ScheduledAgentTaskResult | null> {
  const selfCheckContract = await readCurrentRunContract(input.runSpecId, running.metadata);
  if (!selfCheckContract || !shouldRunSelfCheck(selfCheckContract)) return null;

  // Use judge provider/model when configured, fall back to agent's provider/model
  const config = getConfig();
  const judgeProvider = config.judge.provider || input.provider;
  const judgeModel = config.judge.model || input.model;

  const selfCheckProvider = createProvider(judgeProvider, {
    model: judgeModel,
    traceId: input.traceId,
  });
  const contextSummary = summarizeAgentContext(result);
  const selfCheckResult = await runPostExecutionSelfCheck({
    goal: selfCheckContract.goal!,
    stopConditions: selfCheckContract.stopConditions ?? [],
    agentOutput: result.text,
    contextSummary,
    provider: selfCheckProvider,
    traceId: input.traceId,
  });

  await emitTaskEvent(sessionId, 'task.self_check_completed', running as any, {
    selfCheckResult,
  });

  if (!selfCheckResult.selfCheckPassed) {
    const gapSummary = selfCheckResult.gaps
      .map(g => `[${g.condition}] ${g.detail} → ${g.suggestion}`)
      .join('; ');
    await transitionExecutionState({
      entityType: 'task_run',
      entityId: taskRunId,
      to: 'blocked',
      sessionId,
      reason: 'goal_self_check_failed',
    });
    const blocked = await updateTaskRunFields(taskRunId, {
      metadata: {
        ...running.metadata,
        selfCheckResult,
        blockReason: `Goal self-check failed: ${gapSummary}`,
        loopCount: result.loopCount,
        totalTokens: result.totalTokens,
      },
    });
    const finalBlocked = blocked ?? (running as any);
    await emitTaskEvent(sessionId, 'task.blocked', finalBlocked);
    await input.onTaskEvent?.({ type: 'task.blocked', taskRun: finalBlocked });
    return {
      status: 'blocked',
      sessionId,
      taskRun: { ...finalBlocked, status: 'blocked' },
      result,
      reason: `Goal self-check failed: ${gapSummary}`,
    };
  }

  await updateTaskRunFields(taskRunId, {
    metadata: {
      ...running.metadata,
      selfCheckResult,
      loopCount: result.loopCount,
      totalTokens: result.totalTokens,
    },
  });
  return null;
}
