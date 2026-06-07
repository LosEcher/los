import { statSync } from 'node:fs';

export function fileAge(path: string): string | undefined {
  try {
    const age = Date.now() - statSync(path).mtimeMs;
    const days = Math.floor(age / (1000 * 60 * 60 * 24));
    if (days < 1) return 'today';
    if (days < 7) return `${days}d ago`;
    if (days < 30) return `${Math.floor(days / 7)}w ago`;
    return `${Math.floor(days / 30)}mo ago`;
  } catch {
    return undefined;
  }
}

export function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

export function parseJsonObject(value: unknown): Record<string, any> | null {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, any>;
  }
  if (typeof value !== 'string' || value.trim().length === 0) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, any>
      : null;
  } catch {
    return null;
  }
}
