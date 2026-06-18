/** Shared normalizers used by compaction and related memory modules. */

export function normalizeRequired(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} is required`);
  return value.trim();
}

export function normalizeLimit(value: unknown): number {
  const parsed = Number(value ?? 100);
  if (!Number.isFinite(parsed) || parsed <= 0) return 100;
  return Math.max(1, Math.min(1000, Math.floor(parsed)));
}

export function normalizeJsonObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
    } catch { return {}; }
  }
  return {};
}

export function normalizeJsonArray(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) return value.map(v => normalizeJsonObject(v));
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed.map((v: unknown) => normalizeJsonObject(v)) : [];
    } catch { return []; }
  }
  return [];
}

export function parseJsonArray(raw: string | undefined): Record<string, unknown>[] {
  if (!raw) return [];
  try { return JSON.parse(raw) as Record<string, unknown>[]; } catch { return []; }
}

export function toIsoString(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
