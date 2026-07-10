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

      const actor = ctx.inbound.channelId || `im:${ctx.inbound.sourceKind}`;
      const reason =
        i.reason
        ?? `MessageRouter ${i.action} via ${ctx.inbound.sourceKind}`;

      try {
        if (i.action === 'approve_phase') {
          const updated = await approveRunSpecPhase(i.runId, { actor, reason });
          const phase = updated.runContract?.phase ?? 'plan_approved';
          const prev = updated.runContract?.previousPhase ?? 'unknown';
          const text = `✅ Plan approved for run ${i.runId.slice(0, 12)}…\nphase: ${prev} → ${phase}`;
          await ctx.reply(text);
          return { handled: true, text, sessionId: updated.sessionId };
        }

        if (i.action === 'revise_plan') {
          const updated = await reviseRunSpecPlan(i.runId, { actor, reason });
          const rev = updated.runContract?.planRevision ?? 1;
          const phase = updated.runContract?.phase ?? 'planning';
          const text = [
            `📝 Plan revised for run ${i.runId.slice(0, 12)}…`,
            `revision: ${rev} | phase: ${phase}`,
            reason ? `reason: ${reason.slice(0, 120)}` : '',
          ].filter(Boolean).join('\n');
          await ctx.reply(text);
          return { handled: true, text, sessionId: updated.sessionId };
        }

        if (i.action === 'verify_run') {
          const runSpec = await loadRunSpec(i.runId);
          if (!runSpec) {
            const text = `Run "${i.runId.slice(0, 12)}…" not found.`;
            await ctx.reply(text);
            return { handled: true, text, error: 'run_not_found' };
          }
          const result = await runVerificationRecordsForRunSpec(i.runId, {});
          const total = result.records.length;
          const succeeded = result.records.filter((r) => r.status === 'succeeded' || r.status === 'skipped').length;
          const failed = result.decision.failedVerificationRecordIds.length;
          const pending = result.decision.pendingVerificationRecordIds.length;
          const text = [
            `🔍 Verify run ${i.runId.slice(0, 12)}…`,
            `records: ${total} | ran: ${result.ranRecordIds.length}`,
            `succeeded/skipped: ${succeeded} | failed: ${failed} | pending: ${pending}`,
            `decision: ${result.decision.status}`,
          ].join('\n');
          await ctx.reply(text);
          return { handled: true, text, sessionId: runSpec.sessionId };
        }

        await ctx.reply('Usage: #approve-phase <runId> [reason] | #revise-plan <runId> [reason] | #verify-run <runId>');
        return { handled: true };
      } catch (err) {
        const msg = (err as Error).message;
        await ctx.reply(`RunContract op failed: ${msg}`);
        return { handled: true, error: msg };
      }
    },
  };
}
