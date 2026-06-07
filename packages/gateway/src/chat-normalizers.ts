/**
 * Chat request body normalizers — extracted from chat-route.ts.
 */

import { resolve } from 'node:path';

export type ToolMode = 'all' | 'project-write' | 'read-only';

export interface MCPRequestServer {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface ToolRetryInput {
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
}

export function normalizeWorkspaceRoot(value: unknown, defaultWorkspaceRoot: string): string {
  if (typeof value !== 'string') return defaultWorkspaceRoot;
  const trimmed = value.trim();
  return trimmed ? resolve(trimmed) : defaultWorkspaceRoot;
}

export function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

export function normalizeToolMode(value: unknown): ToolMode {
  if (value === 'read-only' || value === 'project-write' || value === 'all') return value;
  return 'project-write';
}

export function normalizeAllowedTools(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const tools = value.map(item => typeof item === 'string' ? item.trim() : '').filter(Boolean);
  return tools.length > 0 ? [...new Set(tools)] : undefined;
}

export function normalizePositiveInteger(value: unknown): number | undefined {
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return undefined;
    return Math.floor(parsed) > 0 ? Math.floor(parsed) : undefined;
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  const int = Math.floor(value);
  return int > 0 ? int : undefined;
}

export function normalizeNonNegativeInteger(value: unknown): number | undefined {
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return undefined;
    return Math.floor(parsed) >= 0 ? Math.floor(parsed) : undefined;
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  const int = Math.floor(value);
  return int >= 0 ? int : undefined;
}

export function normalizeToolRetry(value: unknown): ToolRetryInput | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  return {
    maxAttempts: normalizePositiveInteger(raw.maxAttempts),
    baseDelayMs: normalizeNonNegativeInteger(raw.baseDelayMs),
    maxDelayMs: normalizeNonNegativeInteger(raw.maxDelayMs),
  };
}

export function normalizeMCPServers(value: unknown): MCPRequestServer[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const servers: MCPRequestServer[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const raw = item as Record<string, unknown>;
    const command = typeof raw.command === 'string' ? raw.command.trim() : '';
    if (!command) continue;
    const server: MCPRequestServer = { command };
    if (Array.isArray(raw.args)) {
      const args = raw.args.map(a => typeof a === 'string' ? a.trim() : '').filter(Boolean);
      if (args.length > 0) server.args = args;
    }
    if (raw.env && typeof raw.env === 'object' && !Array.isArray(raw.env)) {
      const env: Record<string, string> = {};
      for (const [k, v] of Object.entries(raw.env as Record<string, unknown>)) {
        if (typeof v === 'string') env[k] = v;
      }
      if (Object.keys(env).length > 0) server.env = env;
    }
    servers.push(server);
  }
  return servers.length > 0 ? servers : undefined;
}
