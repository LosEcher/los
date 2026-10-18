// Shared helpers used across gateway route modules.

export function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

export function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === 'string').map(s => s.trim()).filter(Boolean);
}

export function normalizeMemoryMetadata(
  value: unknown,
  defaults?: Record<string, unknown>,
): Record<string, unknown> {
  const base = { ...defaults };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return base;
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v === 'string' && v.trim()) base[k] = v.trim();
    else if (v !== null && v !== undefined) base[k] = v;
  }
  return base;
}

export function parseOptionalBoolean(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return undefined;
}

export function normalizeOptionalNonNegativeInteger(value: unknown): number | undefined {
  if (typeof value === 'number') return value >= 0 ? Math.floor(value) : undefined;
  if (typeof value === 'string') {
    const n = parseInt(value);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return undefined;
}

export function normalizeOptionalNonNegativeNumber(value: unknown): number | undefined {
  if (typeof value === 'number') return value >= 0 ? value : undefined;
  if (typeof value === 'string') {
    const n = parseFloat(value);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return undefined;
}

export function normalizeNonNegativeInteger(value: unknown, fallback: number): number {
  if (typeof value === 'number') return value >= 0 ? Math.floor(value) : fallback;
  if (typeof value === 'string') {
    const n = parseInt(value);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return fallback;
}

/**
 * 严格解析**可选的有界整数查询参数**。
 *
 * 为什么不复用 `normalizeBoundedInteger`（它是夹取的）：夹取会让
 * `?limit=99999` 静默变成上限值，调用方以为自己的过滤生效了。
 * 新增的有界参数一律**显式失败**（400 + 指名参数与范围），
 * 缺省由调用方决定（返回 `value: undefined`，不在这里塞默认值）。
 */
export type BoundedIntegerParamResult =
  | { ok: true; value: number | undefined }
  | { ok: false; message: string };

export function parseBoundedIntegerParam(
  value: unknown,
  name: string,
  min: number,
  max: number,
): BoundedIntegerParamResult {
  if (value === undefined || value === null || value === '') return { ok: true, value: undefined };
  const parsed = typeof value === 'number' ? value : Number(String(value));
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < min || parsed > max) {
    return { ok: false, message: `${name} must be an integer between ${min} and ${max}` };
  }
  return { ok: true, value: parsed };
}

export function normalizeBoundedInteger(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === 'string'
    ? parseInt(value)
    : typeof value === 'number'
      ? value
      : NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

export function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

export function normalizeNonNegativeNumber(value: unknown): number {
  if (typeof value === 'number' && value >= 0) return value;
  const n = typeof value === 'string' ? parseFloat(value) : 0;
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

export function truncateForHttp(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) + '…' : value;
}

export function sanitizeErrorMessage(message: string): string {
  return message.replace(/sk-[A-Za-z0-9_-]{8,}/g, 'sk-REDACTED');
}

export function sanitizeServiceId(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 128);
}

export function normalizeProviderSummaryStringArray(value: unknown, max: number): string[] {
  const arr = normalizeStringArray(value);
  return arr.slice(0, max);
}
