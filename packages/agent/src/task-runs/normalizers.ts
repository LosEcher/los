export function normalizeLeaseMs(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 30_000;
  const int = Math.floor(value);
  return Math.max(1_000, Math.min(int, 10 * 60_000));
}

export function normalizeJsonObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
    } catch {
      return {};
    }
  }
  return {};
}

export function toIsoString(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

export function assertRow<T>(row: T | undefined): T {
  if (!row) {
    throw new Error('Failed to create task run');
  }
  return row;
}
