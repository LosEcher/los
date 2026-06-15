import type { TodoKind, TodoPriority, TodoRecord, TodoStatus } from '../todo-types.js';

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

export function normalizeStringArray(value: unknown): string[] | undefined {
  if (Array.isArray(value)) {
    const normalized = value.map((item) => normalizeOptionalString(item)).filter((item): item is string => Boolean(item));
    return normalized.length > 0 ? uniqueStrings(normalized) : undefined;
  }
  if (typeof value === 'string') {
    const normalized = value.split(',').map((item) => normalizeOptionalString(item)).filter((item): item is string => Boolean(item));
    return normalized.length > 0 ? uniqueStrings(normalized) : undefined;
  }
  return undefined;
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

export function normalizeTodoKind(value: unknown, fallback: TodoKind = 'task'): TodoKind {
  if (value === 'problem' || value === 'solution' || value === 'plan' || value === 'phase' || value === 'task' || value === 'batch') return value;
  return fallback;
}

export function normalizeTodoStatus(value: unknown, fallback: TodoStatus = 'backlog'): TodoStatus {
  if (value === 'backlog' || value === 'ready' || value === 'in_progress' || value === 'blocked' || value === 'done' || value === 'cancelled') return value;
  return fallback;
}

export function normalizeTodoPriority(value: unknown, fallback: TodoPriority = 'P2'): TodoPriority {
  if (value === 'P0' || value === 'P1' || value === 'P2' || value === 'P3') return value;
  return fallback;
}

export function pickNullable(value: string | null | undefined, fallback: string | undefined): string | null {
  if (value === null) return null;
  return normalizeOptionalString(value) ?? fallback ?? null;
}

export function appendOptionalClause(
  clauses: string[],
  params: unknown[],
  column: string,
  value: unknown,
): void {
  const normalized = normalizeOptionalString(value);
  if (!normalized) return;
  params.push(normalized);
  clauses.push(`${column} = $${params.length}`);
}

export function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const normalized = normalizeOptionalString(value);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

export function toIsoString(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

export function assertRow<T>(row: T | null | undefined): T {
  if (!row) throw new Error('Failed to write todo');
  return row;
}
