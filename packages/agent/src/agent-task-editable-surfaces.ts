import type { AgentTaskRecord } from './agent-task-graph.js';

export type EditableSurfaceConflictMode = 'ignore' | 'exclude-overlaps' | 'require-declared';

export function selectEditableSurfaceCompatibleTasks(
  tasks: readonly AgentTaskRecord[],
  limit: number,
  mode: EditableSurfaceConflictMode = 'exclude-overlaps',
  runningTasks: readonly AgentTaskRecord[] = [],
): AgentTaskRecord[] {
  const max = Math.max(1, Math.min(50, Math.floor(limit)));
  if (mode === 'ignore') return tasks.slice(0, max);
  const selected: AgentTaskRecord[] = [];
  const selectedSurfaces: string[] = runningTasks.flatMap(editableSurfacesForAgentTask);

  for (const task of tasks) {
    if (selected.length >= max) break;
    const surfaces = editableSurfacesForAgentTask(task);
    if (mode === 'require-declared' && surfaces.length === 0) continue;
    if (surfaces.some(surface => selectedSurfaces.some(existing => editableSurfacesOverlap(existing, surface)))) {
      continue;
    }
    selected.push(task);
    selectedSurfaces.push(...surfaces);
  }

  return selected;
}

export function editableSurfacesForAgentTask(task: Pick<AgentTaskRecord, 'metadata'>): string[] {
  const metadata = task.metadata ?? {};
  const runContract = metadata.runContract && typeof metadata.runContract === 'object' && !Array.isArray(metadata.runContract)
    ? metadata.runContract as Record<string, unknown>
    : undefined;
  return uniqueStrings([
    ...normalizeStringList(metadata.editableSurfaces),
    ...normalizeStringList(metadata.editableSurface),
    ...normalizeStringList(metadata.editablePaths),
    ...normalizeStringList(metadata.editablePath),
    ...normalizeStringList(runContract?.editableSurfaces),
  ].map(normalizeEditableSurface).filter((item): item is string => Boolean(item)));
}

export function editableSurfacesOverlap(left: string, right: string): boolean {
  const a = normalizeEditableSurface(left);
  const b = normalizeEditableSurface(right);
  if (!a || !b) return false;
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

export function normalizeEditableSurfaceMode(value: unknown): EditableSurfaceConflictMode {
  if (value === 'ignore' || value === 'exclude-overlaps' || value === 'require-declared') return value;
  return 'exclude-overlaps';
}

function normalizeStringList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(normalizeOptionalString).filter((item): item is string => Boolean(item));
  const normalized = normalizeOptionalString(value);
  if (!normalized) return [];
  return normalized.split(',').map(item => item.trim()).filter(Boolean);
}

function normalizeEditableSurface(value: unknown): string | undefined {
  const normalized = normalizeOptionalString(value);
  if (!normalized) return undefined;
  return normalized
    .replace(/\\/g, '/')
    .replace(/\/+/g, '/')
    .replace(/^\.\//, '')
    .replace(/\/$/, '');
}

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function uniqueStrings(value: readonly string[]): string[] {
  return [...new Set(value.map(item => item.trim()).filter(Boolean))];
}
