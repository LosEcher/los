/**
 * cross-project-routes — 跨项目事实面只读端点（契约 `los.cross-project-summary`）。
 *
 * 数据来源是 los 自己的三张投影表（P1 L1-2），**不**在请求期读 DSH 的 SQLite：
 * 那是离线投影器（`pnpm project:dsh-sessions`）的职责 ⇒ 本端点不会阻塞在
 * DSH 侧、也不会改动 canonical 会话日志。
 *
 * 消费方是 `dsh-dashboards` 的跨项目卡片（它按既有权约定代理本端点）。
 */
import type { FastifyInstance } from 'fastify';
import { getCrossProjectSummary, type CrossProjectSummary } from '@los/agent';

export type CrossProjectRoutesDependencies = {
  getCrossProjectSummary: typeof getCrossProjectSummary;
};

const defaultDependencies: CrossProjectRoutesDependencies = { getCrossProjectSummary };

export function registerCrossProjectRoutes(
  app: FastifyInstance,
  deps: CrossProjectRoutesDependencies = defaultDependencies,
): void {
  app.get('/cross-project/summary', async (req, reply) => {
    const q = (req.query ?? {}) as { painLimit?: string; injectionDays?: string };
    const parse = (v: string | undefined, lo: number, hi: number, dflt: number): number => {
      const n = v === undefined ? NaN : Number(v);
      return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.trunc(n))) : dflt;
    };
    const summary: CrossProjectSummary = await deps.getCrossProjectSummary({
      painLimit: parse(q.painLimit, 1, 50, 10),
      injectionDays: parse(q.injectionDays, 1, 90, 14),
    });
    // 投影缺失是 **200 + degraded 标记**，不是 5xx：服务本身是健康的，
    // 缺的是数据面。用 5xx 会让消费方把它当故障，用 200 但隐去 degraded
    // 又会让它把"没投影"当成"确实没有"。
    reply.header('cache-control', 'no-store');
    return summary;
  });
}
