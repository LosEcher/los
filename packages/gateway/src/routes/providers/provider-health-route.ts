/**
 * Provider health projection — read-only snapshot of the in-memory health
 * scores computed by the provider probe loop (provider-probe + provider-health,
 * ADR 0043). Consumed by dashboards and by DSH-style clients that want to
 * fail-fast before calling an unhealthy provider instead of discovering the
 * failure mid-request.
 *
 * Returns whatever the probe loop has computed so far; an empty list means the
 * loop has not produced scores yet (probe interval is 60s while active, 300s
 * idle), not that providers are down.
 *
 * 2026-10-27: 加了**按原因计数的直方图**（`reasons`）与每个 provider 的 `reason`。
 * 动因：`tier` 四档把"RTT 慢 / 成功率低 / 探针不可达"压成一类，而三者处置完全不同；
 * 只有 tier 时读表的人必须重新逐条翻 details。**空列表另用 `degraded` 表达** ——
 * `reasons: {}` 不许被读成"全绿"（空即通过是本项目反复踩过的反模式）。
 */
import type { FastifyInstance } from 'fastify';
import { getAllCachedHealthScores, healthReason, histogramByHealthReason } from '@los/agent/providers/health';

export function registerProviderHealthRoute(app: FastifyInstance): void {
  app.get('/providers/health', async () => {
    const providers = getAllCachedHealthScores().map((p) => ({ ...p, reason: healthReason(p) }));
    return {
      probedAt: new Date().toISOString(),
      providers,
      // 桶和恒等于 providers.length（见 provider-health.test.ts 的断言）
      reasons: histogramByHealthReason(providers),
      // 探针还没产出分数时的显式降级：与"全部健康"是两句话
      degraded: providers.length === 0
        ? { reason: 'probe-loop-has-not-produced-scores', note: '探针循环尚未产出分数（60s 活跃 / 300s 空闲）——不是"全部健康"，也不是"全部故障"' }
        : null,
    };
  });
}
