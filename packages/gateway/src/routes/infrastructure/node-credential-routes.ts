/**
 * 节点入网 / 凭据轮换路由（从 `node-routes.ts` 拆出）。
 *
 * 拆出的原因：node-routes 已逼近 500 行结构门禁，而这三条路由共享同一个主题
 * ——「节点身份怎么发、怎么换」——独立成文件比继续堆在大文件里更清楚。
 */
import type { FastifyInstance } from 'fastify';
import { getConfig } from '@los/infra/config';
import {
  ensureNodeEnrollmentStore,
  issueNodeEnrollmentToken,
  redeemNodeEnrollmentToken,
  rotateNodeCredential,
} from '@los/agent/node-enrollment';
import { requireOperator } from '../../request-context.js';
import { normalizeOptionalString } from '../server-helpers.js';

export function registerNodeCredentialRoutes(app: FastifyInstance): void {
  app.post('/nodes/enrollment-tokens', async (req, reply) => {
    if (!(await requireOperator(req, reply))) return;
    const body = req.body as Record<string, unknown> | undefined;
    const nodeId = normalizeOptionalString(body?.nodeId ?? body?.node_id);
    if (!nodeId) return reply.status(400).send({ error: 'nodeId is required' });
    const ttlMs = typeof body?.ttlMs === 'number' && Number.isFinite(body.ttlMs) ? body.ttlMs : undefined;
    await ensureNodeEnrollmentStore();
    return await issueNodeEnrollmentToken(nodeId, ttlMs);
  });

  app.post('/nodes/enroll', async (req, reply) => {
    const body = req.body as Record<string, unknown> | undefined;
    const token = normalizeOptionalString(body?.token);
    const nodeId = normalizeOptionalString(body?.nodeId ?? body?.node_id);
    if (!token || !nodeId) return reply.status(400).send({ error: 'token and nodeId are required' });
    await ensureNodeEnrollmentStore();
    const ttlDays = getConfig().executor.nodeCredentialTtlDays;
    const result = await redeemNodeEnrollmentToken(token, nodeId, ttlDays * 24 * 60 * 60_000);
    if (!result) return reply.status(401).send({ error: 'invalid, expired, consumed, or mismatched enrollment token' });
    return result;
  });

  /**
   * 节点自助轮换：用**当前凭据**换新凭据，不需要 operator 发一次性 token。
   *
   * 旧值在 24h 重叠窗口内仍可用（`node_enrollments.previous_*`），所以响应丢失或
   * 写盘失败不会立刻把节点锁死。过期凭据换不了——那时只能重新 enroll（人工兜底）。
   */
  app.post('/nodes/credential/rotate', async (req, reply) => {
    const body = req.body as Record<string, unknown> | undefined;
    const credential = normalizeOptionalString(
      (req.headers['x-los-node-credential'] as string | undefined) ?? body?.credential,
    );
    if (!credential) return reply.status(400).send({ error: 'node credential is required' });
    const ttlDays = getConfig().executor.nodeCredentialTtlDays;
    const rotated = await rotateNodeCredential(credential, ttlDays * 24 * 60 * 60_000);
    if (!rotated) return reply.status(401).send({ error: 'invalid or expired node credential' });
    return rotated;
  });
}
