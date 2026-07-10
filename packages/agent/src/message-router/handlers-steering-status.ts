/**
 * Session steering (#approve/#deny/#escalate) and #status handlers.
 * Kept separate so handlers.ts stays under the 400-line gate.
 */
import { loadSession } from '@los/agent/session';
import { getSessionObservability } from '@los/agent/session-events';
import { recordOperatorSteering } from '@los/agent/operator-control';
import type { HandlerDescriptor, ResolvedIntent } from './types.js';

export function createSteeringHandler(): HandlerDescriptor {
  return {
    name: 'steering',
    priority: 30,
    match: (intent: ResolvedIntent) => intent.type === 'steering',
    handle: async (ctx) => {
      const i = ctx.intent;
      if (i.type !== 'steering') return { handled: false };
      try {
        await recordOperatorSteering({
          sessionId: i.sessionId,
          instruction: i.instruction,
          turnBoundary: i.turnBoundary ?? 'immediate',
          actor: ctx.principal.kind === 'operator'
            ? ctx.principal.subject
            : `unauthorized:${ctx.inbound.sourceKind}`,
          reason: `MessageRouter steering via ${ctx.inbound.sourceKind}`,
        });
        const label = i.instruction === 'approve' ? '✅ 已批准（tool/steering）'
          : i.instruction === 'deny' ? '❌ 已拒绝（tool/steering）'
          : '↗ 已升级';
        const text = [
          label,
          `Session: ${i.sessionId}`,
          '说明: 这是会话级指令，不是 Run 计划审批。',
          '计划审批请用: #approve-phase <完整runId>',
        ].join('\n');
        await ctx.reply(text);
        return { handled: true, text, sessionId: i.sessionId };
      } catch (err) {
        const text = `❌ 指令失败\nSession: ${i.sessionId}\n${(err as Error).message}`;
        await ctx.reply(text);
        return { handled: true, error: (err as Error).message, text };
      }
    },
  };
}

export function createStatusHandler(): HandlerDescriptor {
  return {
    name: 'status',
    priority: 30,
    match: (intent: ResolvedIntent) => intent.type === 'status',
    handle: async (ctx) => {
      const i = ctx.intent;
      if (i.type !== 'status') return { handled: false };
      try {
        const session = await loadSession(i.sessionId);
        if (!session) {
          const text = [
            '❌ 未找到 Session',
            `查询: ${i.sessionId}`,
            '请复制告警里的完整 Session 行（不要只写 session-）。',
          ].join('\n');
          await ctx.reply(text);
          return { handled: true, text };
        }
        const obs = await getSessionObservability(i.sessionId);
        const first = obs.firstEventAt ? new Date(obs.firstEventAt).toLocaleString('zh-CN') : '—';
        const last = obs.lastEventAt ? new Date(obs.lastEventAt).toLocaleString('zh-CN') : '—';
        const statusText = [
          '📊 会话状态',
          `Session: ${i.sessionId}`,
          `事件: ${obs.eventCount} | 轮次: ${obs.turnCount}`,
          `Token: 入 ${obs.totalUsage.promptTokens} / 出 ${obs.totalUsage.completionTokens}（缓存命中 ${obs.totalUsage.cacheHitTokens}）`,
          `首次: ${first}`,
          `最近: ${last}`,
        ].join('\n');
        await ctx.reply(statusText);
        return { handled: true, text: statusText, sessionId: i.sessionId };
      } catch (err) {
        const text = `❌ 查询失败\nSession: ${i.sessionId}\n${(err as Error).message}`;
        await ctx.reply(text);
        return { handled: true, error: (err as Error).message, text };
      }
    },
  };
}
