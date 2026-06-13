import { normalizeOptionalString } from '../scheduler/helpers.js';
import type { AgentTaskRole, AgentTaskStatus, AgentTaskAttemptStatus } from './types.js';

export function normalizeRole(value: unknown): AgentTaskRole {
  return value === 'planner' || value === 'executor' || value === 'verifier' ? value : 'executor';
}

export function normalizeTaskStatus(value: unknown): AgentTaskStatus {
  return value === 'queued' || value === 'running' || value === 'succeeded' || value === 'failed' || value === 'cancelled' || value === 'blocked' ? value : 'queued';
}

export function normalizeAttemptStatus(value: unknown): AgentTaskAttemptStatus {
  return value === 'running' || value === 'succeeded' || value === 'failed' || value === 'cancelled' ? value : 'running';
}

export function normalizePriority(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 100;
}

export function normalizeOptionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function normalizeRequiredString(value: unknown, name: string): string {
  const normalized = normalizeOptionalString(value);
  if (!normalized) throw new Error(`${name} is required`);
  return normalized;
}

export function uniqueStrings(value: readonly string[]): string[] { return [...new Set(value.map(item => item.trim()).filter(Boolean))]; }

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

export function normalizeJsonStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return uniqueStrings(value.filter((item): item is string => typeof item === 'string'));
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? normalizeJsonStringArray(parsed) : [];
    } catch {
      return [];
    }
  }
  return [];
}

export function toIsoString(value: Date | string): string { return value instanceof Date ? value.toISOString() : new Date(value).toISOString(); }

export function assertRow<T>(row: T | undefined): T {
  if (!row) throw new Error('agent task graph write returned no row');
  return row;
}
