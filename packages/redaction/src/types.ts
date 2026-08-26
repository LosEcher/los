/**
 * @los/redaction — RedactedString 类型级隐私守卫。
 *
 * 借鉴 grok-bot-0.18-reconstructed 的 RedactedString 设计：
 *
 *  - 私有原文 #value + 分类 + 字段名 + 隐私模式；
 *  - unwrap(purpose)：按用途显式取原文；越权时 redact 模式返回脱敏值、
 *    enforce 模式抛错（fail-closed）；CREDENTIALS 硬底线永不放行；
 *  - 隐式序列化钩子：toString / toJSON / valueOf / Symbol.toPrimitive 全部走
 *    #logImplicitSerialization——dev（NODE_ENV !== 'production' 且未设
 *    LOS_REDACTION_SILENT）抛错、生产静默返回脱敏值。防止"脱敏值被悄悄当
 *    普通字符串拼进日志/上下文/请求体"；
 *  - 字符串方法全部 #rewrap 保持包装——脱敏不因字符串变换（trim/slice/
 *    replace/…）而丢失；比较/查询方法读原文（不产生输出）。
 *
 * 用法：敏感字段的类型写 RedactedString；出站边界用
 *   value.unwrap('telemetry' | 'agent-context' | 'external-request')
 * 显式取用；内部计算用 value.unwrap('internal')。
 */

import {
  allowedPurpose,
  formatRedacted,
  isHardRedacted,
  shouldRedact,
  type DataClassification,
  type PrivacyCapability,
  type PrivacyMode,
} from './classification.js';

export interface RedactedUnwrapOptions {
  /** 强制按 enforce 语义处理（忽略模式宽容度）。 */
  enforcing?: boolean;
  /** 越权时返回脱敏值而非抛错（enforce 模式下用于降级路径）。 */
  redactUnallowedFieldsInsteadOfThrowing?: boolean;
}

/** 隐式序列化是否在 dev 抛错（逃生门：LOS_REDACTION_SILENT=1 关闭）。 */
function implicitSerializationThrows(): boolean {
  if (process.env.LOS_REDACTION_SILENT === '1') return false;
  return process.env.NODE_ENV !== 'production';
}

export class RedactedString {
  readonly #value: string;
  readonly classification: DataClassification;
  readonly fieldName: string;
  readonly mode: PrivacyMode;

  constructor(value: string, classification: DataClassification, fieldName: string, mode: PrivacyMode) {
    this.#value = value;
    this.classification = classification;
    this.fieldName = fieldName;
    this.mode = mode;
  }

  get isRedacted(): boolean {
    return shouldRedact(this.mode, this.classification);
  }

  get length(): number {
    return this.#value.length;
  }

  get empty(): boolean {
    return this.#value.length === 0;
  }

  /** 按用途显式取原文。越权：redact 返回脱敏值；enforce 抛错。CREDENTIALS 永不放行。 */
  unwrap(purpose: PrivacyCapability, options?: RedactedUnwrapOptions): string {
    if (allowedPurpose(this.mode, purpose, this.classification)) return this.#value;
    if (isHardRedacted(this.classification)) {
      // 硬底线：即使 internal 也不给原文（除非显式降级路径提供替代值）。
      if (options?.redactUnallowedFieldsInsteadOfThrowing) return formatRedacted(this.fieldName);
      throw new Error(
        `RedactedString unwrap denied: field=${this.fieldName} classification=${this.classification} purpose=${purpose}`,
      );
    }
    const enforce = options?.enforcing ?? this.mode === 'enforce';
    if (options?.redactUnallowedFieldsInsteadOfThrowing) return formatRedacted(this.fieldName);
    if (!enforce) return formatRedacted(this.fieldName);
    throw new Error(
      `RedactedString unwrap not allowed for purpose ${purpose} with classification ${this.classification} (field=${this.fieldName})`,
    );
  }

  #displayValue(): string {
    return shouldRedact(this.mode, this.classification) ? formatRedacted(this.fieldName) : this.#value;
  }

  #logImplicitSerialization(): void {
    if (!this.isRedacted) return;
    if (implicitSerializationThrows()) {
      throw new Error(
        `Implicit serialization of RedactedString (field=${this.fieldName}, classification=${this.classification}); call unwrap(purpose) explicitly`,
      );
    }
    // 生产：静默返回脱敏显示值（不抛错，避免拖垮宿主）。
  }

  #rewrap(next: string): RedactedString {
    return new RedactedString(next, this.classification, `${this.fieldName}.transform`, this.mode);
  }

  toString(): string {
    this.#logImplicitSerialization();
    return this.#displayValue();
  }

  toJSON(): string {
    this.#logImplicitSerialization();
    return this.#displayValue();
  }

  valueOf(): string {
    this.#logImplicitSerialization();
    return this.#displayValue();
  }

  [Symbol.toPrimitive](hint: string): string | number {
    if (hint === 'string' || hint === 'default') {
      this.#logImplicitSerialization();
      return this.#displayValue();
    }
    return Number.NaN;
  }

  get [Symbol.toStringTag](): string {
    return 'RedactedString';
  }

  // ── 变换方法（保持包装）───────────────────────────

  trim(): RedactedString { return this.#rewrap(this.#value.trim()); }
  trimStart(): RedactedString { return this.#rewrap(this.#value.trimStart()); }
  trimEnd(): RedactedString { return this.#rewrap(this.#value.trimEnd()); }
  slice(start?: number, end?: number): RedactedString { return this.#rewrap(this.#value.slice(start, end)); }
  substring(start: number, end?: number): RedactedString { return this.#rewrap(this.#value.substring(start, end)); }
  toLowerCase(): RedactedString { return this.#rewrap(this.#value.toLowerCase()); }
  toUpperCase(): RedactedString { return this.#rewrap(this.#value.toUpperCase()); }
  replace(search: string | RegExp, replacement: string): RedactedString { return this.#rewrap(this.#value.replace(search, replacement)); }
  replaceAll(search: string | RegExp, replacement: string): RedactedString { return this.#rewrap(this.#value.replaceAll(search, replacement)); }
  padStart(maxLength: number, fill?: string): RedactedString { return this.#rewrap(this.#value.padStart(maxLength, fill)); }
  padEnd(maxLength: number, fill?: string): RedactedString { return this.#rewrap(this.#value.padEnd(maxLength, fill)); }
  concat(...values: string[]): RedactedString { return this.#rewrap(this.#value.concat(...values)); }
  split(separator: string | RegExp, limit?: number): RedactedString[] {
    return this.#value.split(separator, limit).map((part) => this.#rewrap(part));
  }

  // ── 查询方法（读原文，不产生输出）──────────────────

  includes(search: string, position?: number): boolean { return this.#value.includes(search, position); }
  startsWith(search: string, position?: number): boolean { return this.#value.startsWith(search, position); }
  endsWith(search: string, endPosition?: number): boolean { return this.#value.endsWith(search, endPosition); }
  indexOf(search: string, position?: number): number { return this.#value.indexOf(search, position); }
  lastIndexOf(search: string, position?: number): number { return this.#value.lastIndexOf(search, position); }
  search(regexp: string | RegExp): number { return this.#value.search(regexp); }
  localeCompare(that: string, locales?: Intl.LocalesArgument, options?: Intl.CollatorOptions): number {
    return this.#value.localeCompare(that, locales, options);
  }
}
