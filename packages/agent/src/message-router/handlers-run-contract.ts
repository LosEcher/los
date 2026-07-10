/**
 * @los/agent/message-router/handlers-run-contract
 *
 * RunContract phase operators for IM:
 *   #approve-phase <runId> [reason]
 *   #revise-plan <runId> [reason]
 *   #verify-run <runId>
 *
 * Distinct from session-level #approve/#deny steering.
 */

import {
  approveRunSpecPhase,
  loadRunSpec,
  reviseRunSpecPlan,
} from '../run-specs.js';
import { runVerificationRecordsForRunSpec } from '../verification-runner.js';
import type {
  HandlerDescriptor,
  HandlerContext,
  ResolvedIntent,
} from './types.js';

export function createRunContractHandler(): HandlerDescriptor {
  return {
    name: 'run_contract',
    priority: 25,
    match: (intent: ResolvedIntent) => intent.type === 'run_contract',
    handle: async (ctx: HandlerContext) => {
      const i = ctx.intent;
      if (i.type !== 'run_contract') return { handled: false };

      const actor = ctx.principal.kind === 'operator'
        ? ctx.principal.subject
        : `unauthorized:${ctx.inbound.sourceKind}`;
      const reason =
        i.reason
        ?? `MessageRouter ${i.action} via ${ctx.inbound.sourceKind}`;

      try {
        if (i.action === 'approve_phase') {
          const updated = await approveRunSpecPhase(i.runId, { actor, reason });
          const phase = updated.runContract?.phase ?? 'plan_approved';
          const prev = updated.runContract?.previousPhase ?? 'unknown';
          const text = [
            '✅ 计划已批准',
            `Run: ${i.runId}`,
            `Session: ${updated.sessionId}`,
            `阶段: ${prev} → ${phase}`,
            reason ? `原因: ${reason.slice(0, 160)}` : '',
          ].filter(Boolean).join('\n');
          await ctx.reply(text);
          return { handled: true, text, sessionId: updated.sessionId };
        }

        if (i.action === 'revise_plan') {
          const updated = await reviseRunSpecPlan(i.runId, { actor, reason });
          const rev = updated.runContract?.planRevision ?? 1;
          const phase = updated.runContract?.phase ?? 'planning';
          const text = [
            '📝 计划已修订',
            `Run: ${i.runId}`,
            `Session: ${updated.sessionId}`,
            `修订号: ${rev}`,
            `阶段: ${phase}`,
            reason ? `原因: ${reason.slice(0, 160)}` : '',
          ].filter(Boolean).join('\n');
          await ctx.reply(text);
          return { handled: true, text, sessionId: updated.sessionId };
        }

        if (i.action === 'verify_run') {
          const runSpec = await loadRunSpec(i.runId);
          if (!runSpec) {
            const text = [
              '❌ 未找到 Run',
              `Run: ${i.runId}`,
              '请检查 runId 是否完整（以 run- 开头）。',
            ].join('\n');
            await ctx.reply(text);
            return { handled: true, text, error: 'run_not_found' };
          }
          const result = await runVerificationRecordsForRunSpec(i.runId, {});
          const total = result.records.length;
          const succeeded = result.records.filter((r) => r.status === 'succeeded' || r.status === 'skipped').length;
          const failed = result.decision.failedVerificationRecordIds.length;
          const pending = result.decision.pendingVerificationRecordIds.length;
          const text = [
            '🔍 验证结果',
            `Run: ${i.runId}`,
            `Session: ${runSpec.sessionId}`,
            `检查项: 共 ${total}，已跑 ${result.ranRecordIds.length}`,
            `通过/跳过: ${succeeded} | 失败: ${failed} | 待做: ${pending}`,
            `结论: ${result.decision.status}`,
          ].join('\n');
          await ctx.reply(text);
          return { handled: true, text, sessionId: runSpec.sessionId };
        }

        await ctx.reply([
          '用法：',
          '#approve-phase <完整runId> [原因]',
          '#revise-plan <完整runId> [原因]',
          '#verify-run <完整runId>',
        ].join('\n'));
        return { handled: true };
      } catch (err) {
        const msg = (err as Error).message;
        // Common: already plan_approved → invalid transition
        const friendly = /invalid|transition|phase/i.test(msg)
          ? [
              '⚠️ 无法完成该操作',
              `Run: ${i.runId}`,
              msg,
              '若已批准过，可发 #status <sessionId> 查看状态。',
            ].join('\n')
          : `❌ 操作失败\nRun: ${i.runId}\n${msg}`;
        await ctx.reply(friendly);
        return { handled: true, error: msg, text: friendly };
      }
    },
  };
}
