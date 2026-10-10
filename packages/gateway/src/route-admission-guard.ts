/**
 * 启动期路由准入对账（ADR 0048 决策 2，**告警档**）。
 *
 * 为什么有它：CI 门禁（`tools/check-route-admission.mjs`）保证"仓库里的路由都被分类"，
 * 但它拦不住两类东西——**绕过 CI 的部署**，以及**插件在运行期注册的路由**
 * （源码扫描器只能看见 `app.<method>('<path>')`，看不见 `@fastify/static` 这类插件注册）。
 * 本守卫在 `onReady` 把**真实注册表**与生成清单对账，两个方向的漂移都打成指名告警：
 *
 * - 注册了但清单里没有 ⇒ 未分类路由（新增端点没走准入分类，或插件新增了 wildcard）；
 * - 清单里有但没注册 ⇒ 清单过期（路由被删/改名但没重新生成）。
 *
 * 刻意保持**告警档**：翻成 fail-closed 是单独的行为变更（`adr:0048` 决策 2 的后续批次），
 * 且必须先确认没有合法的条件注册（按配置启停的模块）。
 *
 * 实证（2026-10-10）：首次在真实 server 上开启本守卫时，它立刻报出 `GET /*` ——
 * 来自 `server.ts` 里 `@fastify/static` 的 wildcard，**源码门禁对这类路由天生失明**。
 * 这说明运行期守卫不是 CI 门禁的重复，而是补上了它的盲区。
 *
 * 与审计的对应关系：参考实现"声明 vs 实际执行不变式（孤儿检测）"（模式 11）在 los 的落地。
 */
import type { FastifyInstance } from 'fastify';
import { getLogger, type Logger } from '@los/infra/logger';

import { admissionRouteKeys } from './route-admission-inventory.js';

export interface RouteAdmissionGuardOptions {
  /** Inject a logger (tests); defaults to the gateway logger. */
  logger?: Logger;
}

interface RouteAdmissionDiff {
  /** Registered at runtime but absent from the generated inventory. */
  unknown: string[];
  /** Present in the generated inventory but never registered. */
  missing: string[];
}

/**
 * Routes contributed by **framework plugins**, not authored in `src/routes/**`.
 *
 * Listed explicitly (rather than pattern-matched away) so everything else is still
 * reported by name. `GET /*` comes from `@fastify/static` registered in `server.ts`
 * (static assets + SPA fallback).
 */
const PLUGIN_CONTRIBUTED_ROUTES: readonly string[] = ['GET /*'];

function diffRouteAdmission(seen: readonly string[], expected: readonly string[]): RouteAdmissionDiff {
  const ignored = new Set(PLUGIN_CONTRIBUTED_ROUTES);
  const seenSet = new Set([...seen].filter(key => !ignored.has(key)));
  const expectedSet = new Set(expected);
  return {
    unknown: [...seenSet].filter(key => !expectedSet.has(key)).sort(),
    missing: [...expectedSet].filter(key => !seenSet.has(key)).sort(),
  };
}

export function registerRouteAdmissionGuard(
  app: FastifyInstance,
  options: RouteAdmissionGuardOptions = {},
): void {
  const log = options.logger ?? getLogger('route-admission');
  const seen = new Set<string>();

  app.addHook('onRoute', route => {
    const methods = Array.isArray(route.method) ? route.method : [route.method];
    for (const method of methods) {
      // Fastify auto-generates HEAD routes for GET handlers; OPTIONS is handled by
      // the CORS plugin. Neither is authored here, so neither belongs in the diff.
      if (method === 'HEAD' || method === 'OPTIONS') continue;
      seen.add(`${method} ${route.url}`);
    }
  });

  app.addHook('onReady', async () => {
    const { unknown, missing } = diffRouteAdmission([...seen], admissionRouteKeys());
    for (const key of unknown) {
      log.warn(
        `unclassified route registered at startup: ${key} — classify it and regenerate the route inventory ` +
          '(node tools/check-route-admission.mjs --update-embedded --update-inventory)',
      );
    }
    for (const key of missing) {
      log.warn(
        `route on the admission inventory was never registered: ${key} — the generated inventory is stale ` +
          '(node tools/check-route-admission.mjs --update-embedded --update-inventory)',
      );
    }
  });
}
