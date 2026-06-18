import type { AgentResult } from '../loop.js';
import { createProvider } from '../providers/index.js';
import { runPostExecutionSelfCheck, shouldRunSelfCheck, summarizeAgentContext, CONFIDENCE_GATE_THRESHOLD } from '../self-check.js';
import { runMultiRoleReview, type ReviewRoleConfig } from '../review-runner.js';
import { reflectOnFailure, formatReflectionSummary } from '../reflection.js';
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

  const config = getConfig();

  // ── Multi-Role Review (P0) ─────────────────────────────────
  // Runs before the goal self-check. Each role evaluates the agent's output
  // through a different lens (spec compliance, code quality, security, etc.).
  // Roles with findings at or above their blocking severity cause early exit.
  if (config.review.enabled) {
    const reviewRoles: ReviewRoleConfig[] = Object.entries(config.review.roles)
      .filter(([, r]) => r.enabled)
      .map(([name, r]) => {
        const roleProvider = r.provider || config.judge.provider || input.provider;
        const roleModel = r.model || config.judge.model || input.model;
        return {
          name,
          provider: createProvider(roleProvider, { model: roleModel, traceId: input.traceId }),
          systemPrompt: r.systemPrompt,
          blockingSeverity: r.blockingSeverity,
          enabled: r.enabled,
        };
      });

    if (reviewRoles.length > 0) {
      const contextSummary = summarizeAgentContext(result);
      const reviewResult = await runMultiRoleReview(
        reviewRoles,
        selfCheckContract.goal ?? '',
        result.text,
        contextSummary,
        input.traceId,
      );

      await emitTaskEvent(sessionId, 'task.review_completed', running as any, {
        reviewResult,
      });

      // Persist review result in task run metadata
      await updateTaskRunFields(taskRunId, {
        metadata: {
          ...running.metadata,
          reviewResult,
        },
      });

      if (!reviewResult.passed) {
        const blockingSummary = reviewResult.blockingFindings
          .map(f => `[${f.severity}][${f.condition}] ${f.detail}`)
          .join('; ');

        const reflection = reflectOnFailure({
          selfCheck: {
            goalMet: false,
            stopConditionsMet: [],
            summaryOfEvidence: reviewResult.blockingFindings.map(f => f.detail).join('\n'),
            confidence: 0,
            gaps: reviewResult.blockingFindings.map(f => ({
              condition: `review:${f.condition}`,
              detail: f.detail,
              suggestion: f.suggestion,
            })),
            selfCheckPassed: false,
            rawResponse: JSON.stringify(reviewResult),
            evaluatedAt: reviewResult.evaluatedAt,
            skipped: false,
          },
        });

        await transitionExecutionState({
          entityType: 'task_run',
          entityId: taskRunId,
          to: 'blocked',
          sessionId,
          reason: 'multi_role_review_failed',
        });

        await updateTaskRunFields(taskRunId, {
          metadata: {
            ...running.metadata,
            reviewResult,
            blockReason: `Review blocked: ${blockingSummary}`,
            reflection: {
              summary: reflection.summary,
              recoveryType: reflection.recoveryType,
              recoveryActions: reflection.recoveryActions,
            },
            loopCount: result.loopCount,
            totalTokens: result.totalTokens,
          },
        });

        const blockedTaskRun = running as any;
        await emitTaskEvent(sessionId, 'task.blocked', blockedTaskRun);
        await input.onTaskEvent?.({ type: 'task.blocked', taskRun: blockedTaskRun });

        // Create recovery todo
        try {
          const { createTodo } = await import('../todos.js');
          await createTodo({
            title: `Review failed: ${reviewResult.blockingFindings.length} blocking finding(s) for task ${taskRunId.slice(0, 8)}`,
            description: reviewResult.blockingFindings
              .map(f => `- [${f.severity}] **${f.condition}**: ${f.detail}\n  → ${f.suggestion}`)
              .join('\n'),
            kind: 'task',
            status: 'backlog',
            priority: 'P1',
            source: 'review',
            metadata: { sessionId, taskRunId, reviewRoles: reviewResult.roles.map(r => r.roleName) },
          });
        } catch { /* best-effort */ }

        return {
          status: 'blocked',
          sessionId,
          taskRun: { ...blockedTaskRun, status: 'blocked' },
          result,
          reason: `Multi-role review blocked: ${blockingSummary}`,
        };
      }
    }
  }

  // ── Goal Self-Check (existing) ─────────────────────────────
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
    judgeSystemPrompt: config.judge.systemPrompt,
  });

  await emitTaskEvent(sessionId, 'task.self_check_completed', running as any, {
    selfCheckResult,
  });

  if (!selfCheckResult.selfCheckPassed) {
    const gapSummary = selfCheckResult.gaps
      .map(g => `[${g.condition}] ${g.detail} → ${g.suggestion}`)
      .join('; ');

    // Phase 4.4 Reflection闭环: analyze failure + suggest recovery
    let reflection = reflectOnFailure({ selfCheck: selfCheckResult });
    try {
      const { listDeadLetterEvents } = await import('../dead-letter.js');
      const similar = await listDeadLetterEvents({ limit: 5 });
      reflection = reflectOnFailure({
        selfCheck: selfCheckResult,
        dlqEvents: similar.filter(e => e.taskRunId !== taskRunId),
      });
    } catch { /* DLQ query is best-effort */ }

    await emitTaskEvent(sessionId, 'session.reflection', running as any, {
      reflection: {
        summary: reflection.summary,
        recoveryType: reflection.recoveryType,
        recoveryActions: reflection.recoveryActions,
        similarFailureCount: reflection.similarFailures.length,
      },
    });

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
        reflection: {
          summary: reflection.summary,
          recoveryType: reflection.recoveryType,
          recoveryActions: reflection.recoveryActions,
        },
        loopCount: result.loopCount,
        totalTokens: result.totalTokens,
      },
    });
    const finalBlocked = blocked ?? (running as any);
    await emitTaskEvent(sessionId, 'task.blocked', finalBlocked);
    await input.onTaskEvent?.({ type: 'task.blocked', taskRun: finalBlocked });

    // Create recovery todo for operator attention
    try {
      const { createTodo } = await import('../todos.js');
      await createTodo({
        title: `Recovery: ${reflection.recoveryType === 'retry' ? 'Retry' : 'Review'} task ${taskRunId.slice(0, 8)}`,
        description: formatReflectionSummary(reflection),
        kind: 'task',
        status: 'backlog',
        priority: reflection.recoveryType === 'escalate' ? 'P1' : 'P2',
        source: 'reflection',
        metadata: { sessionId, taskRunId, recoveryType: reflection.recoveryType },
      });
    } catch { /* Todo creation is best-effort */ }

    return {
      status: 'blocked',
      sessionId,
      taskRun: { ...finalBlocked, status: 'blocked' },
      result,
      reason: `Goal self-check failed: ${gapSummary}`,
    };
  }

  // ── Confidence Gate ─────────────────────────────────────────
  // Even when self-check passes (goalMet + all stopConditions met),
  // block if the judge's confidence is below threshold.
  // This prevents low-certainty outputs from auto-succeeding
  // without operator review. (Inspired by: draft → candidate → confirmed)
  if (selfCheckResult.confidence < CONFIDENCE_GATE_THRESHOLD) {
    const confidenceReason = `Confidence gate: judge confidence ${selfCheckResult.confidence.toFixed(2)} < threshold ${CONFIDENCE_GATE_THRESHOLD}`;

    await transitionExecutionState({
      entityType: 'task_run',
      entityId: taskRunId,
      to: 'blocked',
      sessionId,
      reason: 'confidence_gate',
    });

    await updateTaskRunFields(taskRunId, {
      metadata: {
        ...running.metadata,
        selfCheckResult,
        blockReason: confidenceReason,
        loopCount: result.loopCount,
        totalTokens: result.totalTokens,
      },
    });

    await emitTaskEvent(sessionId, 'task.blocked', running as any);
    await input.onTaskEvent?.({ type: 'task.blocked', taskRun: running as any });

    try {
      const { createTodo } = await import('../todos.js');
      await createTodo({
        title: `Review: low-confidence task ${taskRunId.slice(0, 8)} (confidence=${selfCheckResult.confidence.toFixed(2)})`,
        description: `Self-check passed but judge confidence (${selfCheckResult.confidence.toFixed(2)}) is below gate threshold (${CONFIDENCE_GATE_THRESHOLD}).\n\nGoal: ${selfCheckContract.goal}\nEvidence: ${selfCheckResult.summaryOfEvidence}\nGaps: ${selfCheckResult.gaps.length}`,
        kind: 'task',
        status: 'backlog',
        priority: 'P1',
        source: 'confidence_gate',
        metadata: { sessionId, taskRunId, confidence: selfCheckResult.confidence },
      });
    } catch { /* Todo creation is best-effort */ }

    return {
      status: 'blocked',
      sessionId,
      taskRun: { ...(running as any), status: 'blocked' },
      result,
      reason: confidenceReason,
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
