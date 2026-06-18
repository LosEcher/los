import type { ArtifactPathPolicy, ArtifactStatus } from './types.js';

export function normalizeArtifactId(value: unknown): string | undefined {
  const normalized = normalizeOptionalString(value);
  if (!normalized) return undefined;
  if (!/^[A-Za-z0-9._:-]+$/.test(normalized)) {
    throw new Error('artifactId contains unsupported characters');
  }
  return normalized;
}

export function requireArtifactId(value: unknown): string {
  return normalizeArtifactId(value) ?? (() => { throw new Error('artifactId is required'); })();
}

export function requireString(value: unknown, name: string): string {
  const normalized = normalizeOptionalString(value);
  if (!normalized) throw new Error(`${name} is required`);
  return normalized;
}

export function normalizePathPolicy(value: unknown): ArtifactPathPolicy {
  if (value === 'workspace-relative' || value === 'read-only-export') return value;
  return 'artifact-store';
}

export function normalizeArtifactStatus(value: unknown): ArtifactStatus {
  const VALID: ArtifactStatus[] = ['draft', 'candidate', 'reviewed', 'confirmed', 'rejected'];
  if (typeof value === 'string' && VALID.includes(value as ArtifactStatus)) {
    return value as ArtifactStatus;
  }
  return 'draft';
}

export function normalizeLimit(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.max(1, Math.min(Math.floor(value), 500));
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return Math.max(1, Math.min(Math.floor(parsed), 500));
  }
  return 50;
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

export function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

export function toIsoString(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

export function assertRow<T>(row: T | undefined): T {
  if (!row) throw new Error('Artifact write failed');
  return row;
}
