/**
 * @los/agent/event-redaction — 写路径脱敏瀑布（write-path redaction waterfall）。
 *
 * 参照 DSH sessionTelemetry/record 的监听器栈式变换语义：
 * - 瀑布 = 多个变换按注册顺序依次作用于「将要持久化的外发副本」；
 * - 规范日志永不重写：输入对象只读，变换只作用于深拷贝结果；
 * - fail-closed：任一变换抛错 ⇒ 单条事件的 payload 扣留（以安全占位符落库），
 *   不向调用方抛错、不污染同批其他事件；
 * - 默认管线（不可卸载）：密钥键模式 → Bearer/JWT/查询参数密钥值模式 →
 *   字符串长度上限（runtime.* 2000 字符先例推广到全事件）→ 嵌套深度上限 →
 *   序列化大小上限（payload 超出上限以占位对象落库，保证 JSONB 合法）。
 *
 * 注册扩展点：registerPayloadRedactor() 供 telemetry / runtime-adapter 等模块
 * 追加自定义变换（如外部 runtime 摘要的脱敏规则）。
 */

// ── 常量 ──────────────────────────────────────────────

/** 单个字符串叶值最大字符数（runtime.output 2000 先例推广到全事件）。 */
export const MAX_PAYLOAD_STRING_CHARS = 2_000;

/** payload 嵌套最大深度（超出部分替换为占位对象）。 */
export const MAX_PAYLOAD_DEPTH = 12;

/** payload 序列化后最大字节数（超出以占位对象落库，保证 JSONB 合法）。 */
export const MAX_PAYLOAD_JSON_BYTES = 64 * 1024;

export const REDACTED_LITERAL = '[redacted]';
const TRUNCATION_MARKER = '\u2026[truncated]';
const DEPTH_MARKER = '[depth-exceeded]';

/** 密钥键模式：命中键名即整体替换（含嵌套）。 */
const SECRET_KEY_RE = /(secret|token|password|passphrase|api[-_]?key|authorization|cookie|credential|passwd|pwd)/i;

/** 值内嵌密钥模式：查询参数/赋值形式（token=sig、Authorization: ...）。 */
const EMBEDDED_SECRET_RE =
  /(\b(?:token|sig|signature|secret|api[_-]?key|access[_-]?key|password|passwd|pwd|authorization|cookie|credential)\b\s*[=:]\s*)([^&\s"'<>]+)/gi;

/** JWT 形态（三段 base64url）。 */
const JWT_RE = /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g;

// ── 瀑布注册表 ─────────────────────────────────────────

export interface PayloadRedactContext {
  /** 事件类型（session_events.type 或 telemetry.provider_call 等外发面标识）。 */
  type: string;
  /** 从 payload 根到当前值的键路径（供自定义变换定位）。 */
  keyPath: string[];
}

/** 自定义变换：接收（可能是默认管线产出的）值，返回替换值。抛错 ⇒ 该条扣留。 */
export type PayloadRedactor = (value: unknown, ctx: PayloadRedactContext) => unknown;

const redactors = new Set<PayloadRedactor>();

/** 注册一个瀑布变换；返回注销函数。 */
export function registerPayloadRedactor(redactor: PayloadRedactor): () => void {
  redactors.add(redactor);
  return () => {
    redactors.delete(redactor);
  };
}

export function payloadRedactorCount(): number {
  return redactors.size;
}

// ── 值级变换（默认管线） ───────────────────────────────

/** 纯文本脱敏：Bearer/JWT/嵌入密钥赋值形态。 */
export function redactText(value: string): string {
  let out = value.replace(/^Bearer\s+/i, 'Bearer ' + REDACTED_LITERAL);
  out = out.replace(EMBEDDED_SECRET_RE, `$1${REDACTED_LITERAL}`);
  out = out.replace(JWT_RE, REDACTED_LITERAL);
  return out;
}

function truncateString(value: string): string {
  if (value.length <= MAX_PAYLOAD_STRING_CHARS) return value;
  return value.slice(0, MAX_PAYLOAD_STRING_CHARS) + TRUNCATION_MARKER;
}

/** 单值变换：字符串走密钥值模式 + 长度上限；其余原样。 */
function transformLeaf(value: unknown, key: string | null): unknown {
  if (typeof value !== 'string') return value;
  if (key && SECRET_KEY_RE.test(key)) return REDACTED_LITERAL;
  return truncateString(redactText(value));
}

/**
 * 默认管线深度遍历。只读输入，返回脱敏后的新结构。
 * depth 从 0 计数，超出 MAX_PAYLOAD_DEPTH 的节点替换为占位字符串。
 */
function walkRedact(value: unknown, key: string | null, depth: number): unknown {
  if (depth > MAX_PAYLOAD_DEPTH) return DEPTH_MARKER;
  if (Array.isArray(value)) {
    // 数组元素不继承父键名（与历史 redactValue 语义一致：避免 token 族键名
    // 误伤 tokens 之类的计数数组）。
    return value.map((item) => walkRedact(item, null, depth + 1));
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [childKey, childValue] of Object.entries(value as Record<string, unknown>)) {
      out[childKey] = walkRedact(childValue, childKey, depth + 1);
    }
    return out;
  }
  return transformLeaf(value, key);
}

/** 序列化大小上限：超出则整个 payload 以占位对象落库（JSONB 合法）。 */
function capSerializedSize(value: unknown, type: string): unknown {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) return { redaction: { status: 'unsupported', type } };
  if (serialized.length <= MAX_PAYLOAD_JSON_BYTES) return value;
  return {
    redaction: {
      status: 'truncated',
      type,
      maxBytes: MAX_PAYLOAD_JSON_BYTES,
      actualBytes: serialized.length,
    },
  };
}

// ── 入口 ──────────────────────────────────────────────

const WITHHELD = {
  redaction: { status: 'withheld', reason: 'redactor threw; payload withheld (fail-closed)' },
} as const;

/**
 * 写路径统一脱敏入口：默认管线 + 已注册变换，fail-closed。
 * 输入对象不被修改；返回可安全持久化的 payload。
 */
export function redactPayload(value: unknown, type: string): Record<string, unknown> {
  let result: unknown = walkRedact(value, null, 0);

  for (const redactor of redactors) {
    try {
      result = redactor(result, { type, keyPath: [] });
    } catch {
      // fail-closed：单条扣留，不阻断写入、不向调用方抛错。
      return { ...WITHHELD, type } as Record<string, unknown>;
    }
  }

  const capped = capSerializedSize(result, type);
  if (capped && typeof capped === 'object' && !Array.isArray(capped)) {
    return capped as Record<string, unknown>;
  }
  // 兜底：标量/数组根（正常调用方都传对象；防御性包装）。
  return { value: capped };
}
