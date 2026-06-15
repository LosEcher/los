import type { RunEvalFailoverScope, RunEvalVerificationStatus } from './types.js';

export function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

export function normalizeRequiredString(value: unknown, name: string): string {
  const normalized = normalizeOptionalString(value);
  if (!normalized) throw new Error(`${name} is required`);
  return normalized;
}

export function normalizeOptionalIsoLike(value: unknown, name: string): string | undefined {
  const raw = normalizeOptionalString(value);
  if (!raw) return undefined;
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) throw new Error(`${name} must be a valid timestamp`);
  return date.toISOString();
}

export function normalizeRequiredIsoLike(value: unknown, name: string): string {
  const normalized = normalizeOptionalIsoLike(value, name);
  if (!normalized) throw new Error(`${name} is required`);
  return normalized;
}

export function normalizeNonNegativeInteger(value: unknown, defaultValue: number): number {
  const parsed = Number(value ?? defaultValue);
  if (!Number.isFinite(parsed) || parsed < 0) return defaultValue;
  return Math.floor(parsed);
}

export function normalizeOptionalNonNegativeInteger(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error('integer metric must be non-negative');
  return Math.floor(parsed);
}

export function normalizeOptionalNonNegativeNumber(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error('numeric metric must be non-negative');
  return parsed;
}

export function normalizeJsonObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    } catch {
      return {};
    }
  }
  return {};
}

export function normalizeLimit(value: unknown): number {
  const parsed = Number(value ?? 100);
  if (!Number.isFinite(parsed) || parsed <= 0) return 100;
  return Math.max(1, Math.min(1000, Math.floor(parsed)));
}

export function normalizeCount(value: unknown): number {
  const parsed = Number(value ?? 0);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return Math.floor(parsed);
}

export function normalizeFloat(value: unknown): number {
  const parsed = Number(value ?? 0);
  if (!Number.isFinite(parsed)) return 0;
  return parsed;
}

export function normalizeOptionalFloat(value: unknown): number | undefined {
  if (value === null || value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return undefined;
  return parsed;
}

export function subtractOptional(left: number | undefined, right: number | undefined): number | undefined {
  if (left === undefined || right === undefined) return undefined;
  return left - right;
}

export function normalizeVerificationStatus(value: unknown): RunEvalVerificationStatus {
  if (
    value === 'not_required'
    || value === 'pending'
    || value === 'succeeded'
    || value === 'failed'
    || value === 'skipped'
  ) {
    return value;
  }
  return 'unknown';
}

export function normalizeFailoverScope(value: unknown): RunEvalFailoverScope | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (trimmed === 'service' || trimmed === 'executor') return trimmed;
  return undefined;
}

export function toIsoString(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

export function assertRow<T>(row: T | undefined): T {
  if (!row) throw new Error('run eval write returned no row');
  return row;
}

export function addOptionalClause(clauses: string[], params: unknown[], column: string, value: string | undefined): void {
  if (!value) return;
  params.push(value);
  clauses.push(`${column} = $${params.length}`);
}
