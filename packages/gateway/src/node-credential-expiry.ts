/**
 * 节点凭据到期告警（C.2 第 3 条）。
 *
 * 从 `routes/infrastructure/node-routes.ts` 拆出来，原因有二：
 *  1. 那个文件已经接近 500 行的结构门禁，告警逻辑不该把它推过线；
 *  2. 判定是纯函数，单独一处才能被单测直接咬住（含"过去不告警"的边界）。
 */
import { getLogger } from '@los/infra/logger';

const log = getLogger('node-routes');
/** 到期前多少天开始告警（默认 7 天）。 */
const CREDENTIAL_EXPIRY_WARNING_MS = 7 * 24 * 60 * 60_000;
/** nodeId → 最近一次告警日期（UTC day）。心跳 30s 一次，逐次 WARN 会把日志变成噪声。 */
const credentialWarnings = new Map<string, string>();

export function credentialRotationDue(expiresAt: string, now = Date.now()): boolean {
  const remainingMs = new Date(expiresAt).getTime() - now;
  return Number.isFinite(remainingMs) && remainingMs > 0 && remainingMs <= CREDENTIAL_EXPIRY_WARNING_MS;
}

/**
 * 凭据到期告警文本。`undefined` 表示还早（或已过期——过期凭据在验证层就被拒了，
 * 不该再由告警文案冒充"已通过"）。用剩余天数而不是裸时间戳：值班的人读得出紧迫性
 * （AGENTS.md 展示层 V1）。
 */
export function _credentialExpiryWarning(
  nodeId: string,
  expiresAt: string,
  now = Date.now(),
): string | undefined {
  if (!credentialRotationDue(expiresAt, now)) return undefined;
  const remainingMs = new Date(expiresAt).getTime() - now;
  const days = Math.ceil(remainingMs / (24 * 60 * 60_000));
  return `node credential for ${nodeId} expires in ${days}d (${expiresAt}) — re-enroll before expiry`;
}

/** 心跳里调用：进入 7 天窗口时，每个节点每天最多一条 WARN。 */
export function warnIfCredentialNearExpiry(nodeId: string, expiresAt: string): void {
  const message = _credentialExpiryWarning(nodeId, expiresAt);
  if (!message) return;
  const day = new Date().toISOString().slice(0, 10);
  if (credentialWarnings.get(nodeId) === day) return;
  if (credentialWarnings.size > 5_000) credentialWarnings.clear();
  credentialWarnings.set(nodeId, day);
  log.warn(message);
}
