/**
 * @los/redaction — 脱敏分类学与隐私模式（类型级守卫的地基）。
 *
 * 借鉴 grok-bot-0.18-reconstructed 的 DataClassification × PrivacyMode ×
 * PrivacyCapability 矩阵语义，按 los 场景精简：
 *
 *  - DataClassification：字段级敏感分类。CREDENTIALS 在任何模式、任何用途下
 *    都不允许原样取出（API key / token / password 的硬底线）；PII 仅允许
 *    internal 用途；internal 表示内部派生信息；unspecified 表示未分类（不脱敏）。
 *  - PrivacyMode：三档（对照 grok off/shadow/enforce）——
 *    off     = 不脱敏（兼容/默认）；
 *    redact  = 默认脱敏，显式 unwrap(internal) 可取原文（宽容）；
 *    enforce = 默认脱敏，越权 unwrap 直接抛错（fail-closed）。
 *  - PrivacyCapability：读取原文的"用途"。出站边界（日志/遥测/agent 上下文/
 *    外部请求）必须用对应 purpose 显式 unwrap，禁止隐式序列化（toString/JSON）。
 */

export const DATA_CLASSIFICATIONS = ['credentials', 'pii', 'internal', 'unspecified'] as const;
export type DataClassification = (typeof DATA_CLASSIFICATIONS)[number];

export function isDataClassification(value: unknown): value is DataClassification {
  return typeof value === 'string' && (DATA_CLASSIFICATIONS as readonly string[]).includes(value);
}

/** 硬底线分类：任何模式/用途下都不允许原样读取。 */
export function isHardRedacted(classification: DataClassification): boolean {
  return classification === 'credentials';
}

export const PRIVACY_MODES = ['off', 'redact', 'enforce'] as const;
export type PrivacyMode = (typeof PRIVACY_MODES)[number];

export function isPrivacyMode(value: unknown): value is PrivacyMode {
  return typeof value === 'string' && (PRIVACY_MODES as readonly string[]).includes(value);
}

/** 读取原文的用途。出站边界必须按用途显式 unwrap。 */
export const PRIVACY_CAPABILITIES = ['internal', 'telemetry', 'agent-context', 'external-request'] as const;
export type PrivacyCapability = (typeof PRIVACY_CAPABILITIES)[number];

export function isPrivacyCapability(value: unknown): value is PrivacyCapability {
  return typeof value === 'string' && (PRIVACY_CAPABILITIES as readonly string[]).includes(value);
}

/** 该分类在该模式下是否需要脱敏（决定显示值）。 */
export function shouldRedact(mode: PrivacyMode, classification: DataClassification): boolean {
  if (mode === 'off') return false;
  return classification !== 'unspecified';
}

/** 该用途是否允许取出原文。CREDENTIALS 硬底线永不放行。 */
export function allowedPurpose(
  mode: PrivacyMode,
  purpose: PrivacyCapability,
  classification: DataClassification,
): boolean {
  if (mode === 'off') return true;
  if (isHardRedacted(classification)) return false;
  if (classification === 'unspecified') return true;
  // redact / enforce 模式下，明确分类的信息仅 internal 用途可取原文
  // （telemetry / agent-context / external-request 一律脱敏）。
  return purpose === 'internal';
}

/** 脱敏显示值格式。 */
export function formatRedacted(fieldName: string): string {
  return `[redacted:${fieldName}]`;
}
