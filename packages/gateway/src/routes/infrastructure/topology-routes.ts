import type { FastifyInstance, FastifyRequest } from 'fastify';
import { readFleetTopology } from '../../fleet-topology.js';
import { requireOperator } from '../../request-context.js';

/**
 * 机队拓扑只读端点。
 *
 * 为什么单独一个路由模块（而不是塞进 node-routes）：`node-routes.ts` 已经 478 行，
 * 而结构门禁对"新文件 >500 行"是阻断、对既有文件 >700 行是错误 ——
 * 往里加会把一个已经接近上限的文件推过线。这里是**另一个资源**（拓扑图，不是节点 CRUD）。
 *
 * 鉴权：operator（与 `GET /nodes` 同档）。机队拓扑包含节点地址、阻塞原因与派发计数，
 * 是运维面数据，不是公开面。
 *
 * 参数错误一律 **400**，不静默取默认值：读接口的"宽容"会让调用方以为自己的过滤生效了。
 */

export type TopologyRouteDependencies = {
  readFleetTopology: typeof readFleetTopology;
  requireOperator: typeof requireOperator;
};

const defaultDependencies: TopologyRouteDependencies = {
  readFleetTopology,
  requireOperator,
};

const LIMITS = {
  sinceHours: { min: 1, max: 24 * 30 },
  nodeLimit: { min: 1, max: 500 },
  placementLimit: { min: 1, max: 500 },
  decisionLimit: { min: 1, max: 500 },
} as const;

type NumericParam = keyof typeof LIMITS;

function readNumericParam(
  request: FastifyRequest,
  name: NumericParam,
): { ok: true; value: number | undefined } | { ok: false; message: string } {
  const raw = (request.query as Record<string, unknown> | undefined)?.[name];
  if (raw === undefined || raw === '') return { ok: true, value: undefined };
  const parsed = typeof raw === 'number' ? raw : Number(String(raw));
  const { min, max } = LIMITS[name];
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < min || parsed > max) {
    return { ok: false, message: `${name} must be an integer between ${min} and ${max}` };
  }
  return { ok: true, value: parsed };
}

export function registerTopologyRoutes(
  app: FastifyInstance,
  deps: TopologyRouteDependencies = defaultDependencies,
): void {
  app.get('/topology/fleet', async (request, reply) => {
    if (!(await deps.requireOperator(request, reply))) return;

    const options: Parameters<typeof readFleetTopology>[0] = {};
    for (const name of Object.keys(LIMITS) as NumericParam[]) {
      const read = readNumericParam(request, name);
      if (!read.ok) {
        reply.code(400);
        return { error: read.message };
      }
      if (read.value !== undefined) options[name] = read.value;
    }

    // 与 `/cross-project/summary` 同惯例：只读投影不进任何缓存，宁可让调用方看到 asOf。
    reply.header('cache-control', 'no-store');
    return deps.readFleetTopology(options);
  });
}
