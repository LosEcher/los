/**
 * client-label — 归一化 OpenAI 兼容端点的调用方标识（P2-2 可观测）。
 *
 * 背景（2026-10-09 盘点）：`provider_call_telemetry` 与 `sessions.metadata_json`
 * 都只记 los 自己的 sessionId，**没有任何字段能回答"这次 /v1 调用是谁发起的"**
 * ——于是"DSH 有没有在用 los 网关"只能靠推断（当时结论：近 7 天零流量，但有
 * "没流量"与"没记账"两种解释）。本模块只解决"记账"这一半：把调用方自报的
 * `x-los-client`（优先）或 `User-Agent` 归一化成一个 ≤80 字符的标签，落到会话
 * metadata 的 `client` 字段。
 *
 * 边界（刻意保守）：
 *   - 只读这两个头，从不读 Authorization/Cookie/任何凭据头；
 *   - 只保留单行、去空白、截断，不做任何解析或转发；
 *   - 缺省返回 null（**不得**用 'unknown' 之类兜底值把"没读到"伪装成"读到了"）。
 */

/** 取头部值（Node 的 headers 值可能是 string | string[] | undefined）。 */
function pickHeader(value: unknown): string | null {
  const raw = Array.isArray(value) ? value[0] : value;
  if (typeof raw !== 'string') return null;
  const collapsed = raw.replace(/\s+/g, ' ').trim();
  return collapsed === '' ? null : collapsed;
}

/**
 * 归一化调用方标签：`x-los-client` 优先，其次 `user-agent`，都没有则 null。
 * `maxLen` 默认 80（User-Agent 常见 100+ 字符，全量存没有额外信息量）。
 */
export function resolveClientLabel(
  headers: Record<string, unknown> | undefined,
  maxLen = 80,
): string | null {
  const label = pickHeader(headers?.['x-los-client']) ?? pickHeader(headers?.['user-agent']);
  if (label === null) return null;
  const limit = Number.isFinite(maxLen) && maxLen > 0 ? Math.floor(maxLen) : 80;
  return label.length > limit ? label.slice(0, limit) : label;
}
