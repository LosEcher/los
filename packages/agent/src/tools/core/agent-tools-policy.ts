const CHILD_READ_ONLY_TOOLS = [
  'read_file',
  'list_directory',
  'directory_tree',
  'search_content',
  'search_files',
  'glob',
  'get_file_info',
  'get_symbols',
  'find_in_code',
  'todo_list',
] as const;

const SUBAGENT_PROJECT_WRITE_TOOLS = [
  'read_file',
  'write_file',
  'preview_patch',
  'apply_patch',
  'edit_file',
  'list_directory',
] as const;

export function childAllowedTools(toolMode: 'read-only' | 'project-write'): readonly string[] {
  return toolMode === 'read-only' ? CHILD_READ_ONLY_TOOLS : SUBAGENT_PROJECT_WRITE_TOOLS;
}

export function normalizeString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

export function normalizeToolMode(value: unknown): 'read-only' | 'project-write' | undefined {
  if (value === 'project-write' || value === 'read-only') return value;
  return undefined;
}

export function resolveChildToolMode(
  requested: 'read-only' | 'project-write' | undefined,
  parentToolMode: 'read-only' | 'project-write' | 'all' | undefined,
): 'read-only' | 'project-write' {
  const parent = parentToolMode ?? 'project-write';
  if (parent === 'read-only') return 'read-only';
  return requested === 'project-write' ? 'project-write' : 'read-only';
}

export function normalizeMode(value: unknown): 'sync' | 'background' | undefined {
  if (value === 'sync' || value === 'background') return value;
  return undefined;
}

export function normalizeInteger(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return Math.floor(value);
}
