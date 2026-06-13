import type { ExecutorNodeConnectMode, ExecutorNodeHeartbeatInput, ExecutorNodeRolloutState } from './executor-nodes.js';
import { normalizeOptionalString } from './scheduler/helpers.js';

export { normalizeOptionalString };

export function normalizeRolloutState(value: unknown): ExecutorNodeRolloutState | undefined {
  if (value === 'idle' || value === 'draining' || value === 'upgrading' || value === 'verifying' || value === 'failed') {
    return value;
  }
  return undefined;
}

export function normalizeInteger(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.max(0, Math.floor(value));
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return Math.max(0, Math.floor(parsed));
  }
  return 0;
}

export function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map(item => (typeof item === 'string' ? item.trim() : ''))
    .filter(Boolean);
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

export function normalizeJsonArray(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return [];
  return value
    .map(item => {
      if (item && typeof item === 'object' && !Array.isArray(item)) return item as Record<string, unknown>;
      if (typeof item === 'string' && item.trim()) return { value: item.trim() };
      return null;
    })
    .filter((item): item is Record<string, unknown> => Boolean(item));
}

export function jsonOrNull(value: unknown): string | null {
  return value === undefined ? null : JSON.stringify(value);
}

export function preferredExecutorMode(modes: string[]): string | undefined {
  if (modes.includes('agent_http_ndjson')) return 'agent_http_ndjson';
  if (modes.includes('agent_http')) return 'agent_http';
  return undefined;
}

export function readVerification(verified: Record<string, unknown>, mode: string): boolean | null {
  const value = verified[mode];
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return (value as Record<string, unknown>).ok === true;
}

export function buildHeartbeatVerification(
  existing: Record<string, unknown>,
  connectModes: ExecutorNodeConnectMode[],
  input: ExecutorNodeHeartbeatInput,
): Record<string, unknown> {
  const verified = { ...existing };
  const checkedAt = new Date().toISOString();
  const config = input.connectConfig ?? {};
  for (const mode of connectModes) {
    if (mode !== 'agent_http' && mode !== 'agent_http_ndjson') continue;
    const modeConfig = normalizeJsonObject(config[mode] ?? config.agent_http);
    verified[mode] = {
      ok: true,
      checked_at: checkedAt,
      source: 'heartbeat',
      endpoint: normalizeOptionalString(modeConfig.healthUrl) ?? normalizeOptionalString(modeConfig.baseUrl) ?? input.baseUrl,
    };
  }
  return verified;
}

export function toIsoString(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

export function assertRow<T>(row: T | undefined): T {
  if (!row) throw new Error('Failed to write executor node heartbeat');
  return row;
}
