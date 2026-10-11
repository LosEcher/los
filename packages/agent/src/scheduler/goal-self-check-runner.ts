import type { AgentResult } from '../loop.js';
import { createProvider } from '../providers/index.js';
import { runPostExecutionSelfCheck, shouldRunSelfCheck, summarizeAgentContext, CONFIDENCE_GATE_THRESHOLD } from '../self-check.js';
import { runMultiRoleReview, type ReviewRoleConfig } from '../review-runner.js';
import { reflectOnFailure, formatReflectionSummary } from '../reflection.js';
import { normalizeRunContractMetadata } from '../run-contract.js';
import { normalizeOptionalString } from './helpers.js';
import { readCurrentRunContract } from './contract-reader.js';
import { transitionExecutionState } from '../execution-store.js';
import { updateTaskRunFields, type TaskRunRecord } from '../task-runs.js';
import { emitTaskEvent } from './task-events.js';
import { listRecentSessionEvents } from '../session-events.js';
import { hasAwaitingOperatorEvidence, summarizeToolDenials } from './blocking-evidence.js';
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
  running: Pick<TaskRunRecord, 'metadata' | 'nodeId' | 'leaseVersion'>,
  sessionId: string,
  taskRunId: string,
): Promise<ScheduledAgentTaskResult | null> {
  const selfCheckContract = input.selfCheckContract
    ? normalizeRunContractMetadata(input.selfCheckContract)
    : await readCurrentRunContract(input.runSpecId, running.metadata);
  if (!selfCheckContract || !shouldRunSelfCheck(selfCheckContract)) return null;

  const config = getConfig();

  // B5 (2026-08-17): load blocking evidence from the run's session before any
  // judge call. When the agent ended waiting on a coordinator decision
  // (worker.ask / worker.escalation), the stop-condition self-check has
  // nothing to verify — the run is blocked on a human, not on the goal.
  // Surfacing that directly avoids the misleading "operator cancels schedule"
  // failure that masked the real blocker in the NAS34 sing-box incident.
  let sessionEvents: Array<{ type: string; toolName?: string; payload: Record<string, unknown> }> = [];
  try {
    sessionEvents = await listRecentSessionEvents(sessionId, 300);
  } catch {
    // Event evidence is best-effort; fall through to the judge paths.
  }
  if (hasAwaitingOperatorEvidence(sessionEvents)) {
    const blockReason = 'Awaiting operator decision: the agent requested coordinator direction (worker.ask/escalation) and the run ended before a decision was given';
    await transitionExecutionState({
      entityType: 'task_run',
      entityId: taskRunId,
      to: 'blocked',
      sessionId,
      reason: 'awaiting_operator',
      nodeId: running.nodeId,
      leaseVersion: running.leaseVersion,
    });
    await updateTaskRunFields(taskRunId, {
      metadata: {
        ...running.metadata,
        blockReason,
        loopCount: result.loopCount,
        totalTokens: result.totalTokens,
      },
    });
    await emitTaskEvent(sessionId, 'task.blocked', running as any);
    await input.onTaskEvent?.({ type: 'task.blocked', taskRun: running as any });
    try {
      const { createTodo } = await import('../todos.js');
      await createTodo({
        title: `Awaiting operator: task ${taskRunId.slice(0, 8)} needs a coordinator decision`,
        description: `${blockReason}\n\n${result.text.slice(0, 2000)}`,
        kind: 'task',
        status: 'backlog',
        priority: 'P2',
        source: 'awaiting_operator',
        metadata: { sessionId, taskRunId },
      });
    } catch { /* Todo creation is best-effort */ }
    return {
      status: 'blocked',
      sessionId,
      taskRun: { ...(running as any), status: 'blocked' },
      result,
      reason: blockReason,
    };
  }

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
          nodeId: running.nodeId,
          leaseVersion: running.leaseVersion,
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
  // P0 (2026-08-06 self-check latency): the judge call used to generate
  // 3k-7k hidden thinking tokens on DeepSeek (non-streaming body read took
  // 30-80s). Disable thinking and cap maxTokens; also pass sessionId so
  // provider-call telemetry is attributable instead of empty-session rows.
  const selfCheckResult = await runPostExecutionSelfCheck({
    goal: selfCheckContract.goal!,
    stopConditions: selfCheckContract.stopConditions ?? [],
    agentOutput: result.text,
    contextSummary,
    provider: selfCheckProvider,
    traceId: input.traceId,
    sessionId,
    modelSettings: { thinking: 'disabled', maxTokens: 1024 },
    judgeSystemPrompt: config.judge.systemPrompt,
  });

  await emitTaskEvent(sessionId, 'task.self_check_completed', running as any, {
    selfCheckResult,
  });

  // 留证（2026-10-11 D4/D3）：自检结论此前只进 session 事件，没有可机械核对的记录；
  // 声明的 requiredChecks 在调度路径**从不执行**，于是一条记录都没有——"没检查"必须可见。
  try {
    const { createVerificationRecord } = await import('../verification-records.js');
    const runSpecId = normalizeOptionalString(input.runSpecId);
    await createVerificationRecord({
      id: `verification-${taskRunId}-selfcheck`,
      sessionId,
      runSpecId,
      taskRunId,
      checkName: 'goal_self_check',
      // kind 只允许 command | assertion | operator_review（run-plan-types.ts:26），语义由 checkName 承载
      kind: 'assertion',
      assertion: selfCheckContract.goal ?? undefined,
      reviewer: 'self-check-judge',
      independence: 'separate_model',
      status: selfCheckResult.skipped ? 'skipped' : (selfCheckResult.selfCheckPassed ? 'succeeded' : 'failed'),
      required: false,
      skipReason: selfCheckResult.skipReason,
      outputSummary: selfCheckResult.summaryOfEvidence
        ? selfCheckResult.summaryOfEvidence.slice(0, 500)
        : undefined,
      error: selfCheckResult.selfCheckPassed
        ? undefined
        : selfCheckResult.gaps.map(gap => `[${gap.condition}] ${gap.detail}`).join('; '),
    });
    // 声明式 requiredChecks 的**执行与留证**（2026-10-11）：
    // 本地 run 在本机执行；远端 run 经节点命令通道在该节点执行（`run-check`）。
    // 判定语义**不变**：结果只留证，不改变 run 终态（改成"检查失败即拦"会影响 13 条存量
    // scheduled_execution，属策略决定，见 docs/architecture/2026-10-11-remote-execution-policy-divergence-analysis.md）。
    const declaredChecks = selfCheckContract.requiredChecks ?? [];
    if (declaredChecks.length > 0) {
      const { runScheduledDeclaredChecks } = await import('./declared-checks.js');
      await runScheduledDeclaredChecks({
        sessionId,
        taskRunId,
        runSpecId,
        checks: declaredChecks,
        workspaceRoot: normalizeOptionalString(input.workspaceRoot),
        nodeId: normalizeOptionalString(running.nodeId),
      });
    }
  } catch {
    // 留证失败不得改变判定结果
  }

  // ② 自检**没跑成**（输出为空/过短）≠ 目标没达成：判官根本没评过。
  // 2026-10-11 之前这种情况走"Goal self-check failed"硬拦，文案还谎称"没有产出"
  // （实测一个 16 字符的正确回答 `SMOKE2_…` 即被如此拦下）。
  // 现在走 operator attention（本仓范式：blocked + 独立 reason + review todo，同 confidence_gate），
  // 关键约束：**不自动放行** —— 不置 succeeded，仍需人看一眼。
  if (selfCheckResult.skipped) {
    const attentionReason = `Self-check did not run (${selfCheckResult.skipReason ?? 'unknown'}): `
      + 'the judge never evaluated the output, so the goal is neither confirmed nor refuted — needs a human look';

    await transitionExecutionState({
      entityType: 'task_run',
      entityId: taskRunId,
      to: 'blocked',
      sessionId,
      reason: 'self_check_skipped_needs_operator_attention',
      nodeId: running.nodeId,
      leaseVersion: running.leaseVersion,
    });

    await updateTaskRunFields(taskRunId, {
      metadata: {
        ...running.metadata,
        selfCheckResult,
        blockReason: attentionReason,
        loopCount: result.loopCount,
        totalTokens: result.totalTokens,
      },
    });

    await emitTaskEvent(sessionId, 'task.blocked', running as any);
    await input.onTaskEvent?.({ type: 'task.blocked', taskRun: running as any });

    try {
      const { createTodo } = await import('../todos.js');
      await createTodo({
        title: `Review: self-check skipped for task ${taskRunId.slice(0, 8)} (${selfCheckResult.skipReason ?? 'unknown'})`,
        description: `${attentionReason}\n\nGoal: ${selfCheckContract.goal}\nAgent output: ${result.text.slice(0, 500)}`,
        kind: 'task',
        status: 'backlog',
        priority: 'P1',
        source: 'self_check_skipped',
        metadata: { sessionId, taskRunId, skipReason: selfCheckResult.skipReason },
      });
    } catch { /* Todo creation is best-effort */ }

    return {
      status: 'blocked',
      sessionId,
      taskRun: { ...(running as any), status: 'blocked' },
      result,
      reason: attentionReason,
    };
  }

  if (!selfCheckResult.selfCheckPassed) {
    const denialSummary = summarizeToolDenials(sessionEvents);
    const gapSummary = selfCheckResult.gaps
      .map(g => `[${g.condition}] ${g.detail} → ${g.suggestion}`)
      .join('; ')
      + (denialSummary ? ` | ${denialSummary}` : '');

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
      nodeId: running.nodeId,
      leaseVersion: running.leaseVersion,
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
      nodeId: running.nodeId,
      leaseVersion: running.leaseVersion,
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
