import { readFileSync, writeFileSync } from 'node:fs';
import type { ToolRegistry, ToolResult } from '../core/registry.js';
import { safeWorkspacePath } from '../core/path-safety.js';

export interface PatchToolOptions {
  workspaceRoot: string;
}

type PatchArgs = {
  path: string;
  search: string;
  replace: string;
};

type MatchResult = { ok: true; index: number } | { ok: false; error: string };

export function registerPatchTools(registry: ToolRegistry, options: PatchToolOptions): void {
  const previewHandler = async (args: Record<string, unknown>): Promise<ToolResult> => {
    const patch = normalizePatchArgs(args);
    if (!patch.path || !patch.search) return { content: '', error: 'path and search are required' };

    const absolutePath = safeWorkspacePath(options.workspaceRoot, patch.path);
    const current = readFileSync(absolutePath, 'utf-8');
    const match = findUniqueOccurrence(current, patch.search);
    if (!match.ok) return { content: '', error: match.error };
    const index = match.index;

    const next = applyReplacement(current, index, patch.search, patch.replace);
    return { content: renderPatchPreview(patch.path, current, next, index, patch.search, patch.replace) };
  };

  const applyHandler = async (args: Record<string, unknown>): Promise<ToolResult> => {
    const patch = normalizePatchArgs(args);
    if (!patch.path || !patch.search) return { content: '', error: 'path and search are required' };

    const absolutePath = safeWorkspacePath(options.workspaceRoot, patch.path);
    const current = readFileSync(absolutePath, 'utf-8');
    const match = findUniqueOccurrence(current, patch.search);
    if (!match.ok) return { content: '', error: match.error };
    const index = match.index;

    const next = applyReplacement(current, index, patch.search, patch.replace);
    writeFileSync(absolutePath, next, 'utf-8');
    return { content: renderPatchPreview(patch.path, current, next, index, patch.search, patch.replace, true) };
  };

  registry.register('preview_patch', previewHandler, {
    type: 'function',
    function: {
      name: 'preview_patch',
      description: 'Preview a deterministic file edit by replacing one exact search string with replacement text. Does not write the file.',
      parameters: patchParameters(),
    },
  }, {
    riskLevel: 'L0',
    permissions: ['workspace:read'],
    timeoutMs: 30_000,
    retryable: true,
    idempotent: true,
    costLevel: 'low',
    sideEffect: false,
    tags: ['io', 'read', 'patch'],
  });

  registry.register('apply_patch', applyHandler, {
    type: 'function',
    function: {
      name: 'apply_patch',
      description: 'Apply a deterministic file edit by replacing one exact search string with replacement text. Fails unless the search string appears exactly once.',
      parameters: patchParameters(),
    },
  }, {
    riskLevel: 'L1',
    permissions: ['workspace:write'],
    timeoutMs: 60_000,
    retryable: false,
    idempotent: false,
    costLevel: 'low',
    sideEffect: true,
    tags: ['io', 'write', 'patch'],
  });

  registry.register('edit_file', applyHandler, {
    type: 'function',
    function: {
      name: 'edit_file',
      description: 'Alias for apply_patch. Replace one exact search string with replacement text and fail unless the match is unique.',
      parameters: patchParameters(),
    },
  }, {
    riskLevel: 'L1',
    permissions: ['workspace:write'],
    timeoutMs: 60_000,
    retryable: false,
    idempotent: false,
    costLevel: 'low',
    sideEffect: true,
    tags: ['io', 'write', 'patch'],
  });
}

function normalizePatchArgs(args: Record<string, unknown>): PatchArgs {
  return {
    path: String(args.path ?? ''),
    search: String(args.search ?? ''),
    replace: String(args.replace ?? ''),
  };
}

function patchParameters(): Record<string, unknown> {
  return {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path relative to workspace' },
      search: { type: 'string', description: 'Exact existing text to replace. Must appear exactly once.' },
      replace: { type: 'string', description: 'Replacement text' },
    },
    required: ['path', 'search', 'replace'],
  };
}

function findUniqueOccurrence(content: string, search: string): MatchResult {
  if (search.length === 0) return { ok: false, error: 'search must not be empty' };

  const first = content.indexOf(search);
  if (first < 0) return { ok: false, error: 'search text not found' };

  const second = content.indexOf(search, first + 1);
  if (second >= 0) return { ok: false, error: 'search text is not unique' };

  return { ok: true, index: first };
}

function applyReplacement(content: string, index: number, search: string, replace: string): string {
  return `${content.slice(0, index)}${replace}${content.slice(index + search.length)}`;
}

function renderPatchPreview(
  path: string,
  before: string,
  after: string,
  index: number,
  search: string,
  replace: string,
  applied = false,
): string {
  const beforeLines = countLines(before);
  const afterLines = countLines(after);
  const startLine = lineNumberAt(before, index);
  const removed = search.split('\n');
  const added = replace.split('\n');
  const maxLines = 80;

  return [
    `File: ${path}`,
    `Status: ${applied ? 'applied' : 'preview'}`,
    `Match line: ${startLine}`,
    `Line delta: ${afterLines - beforeLines}`,
    '--- removed',
    ...truncateLines(removed, maxLines).map(line => `- ${line}`),
    '+++ added',
    ...truncateLines(added, maxLines).map(line => `+ ${line}`),
  ].join('\n');
}

function countLines(text: string): number {
  if (text.length === 0) return 0;
  return text.split('\n').length;
}

function lineNumberAt(text: string, index: number): number {
  return text.slice(0, index).split('\n').length;
}

function truncateLines(lines: string[], maxLines: number): string[] {
  if (lines.length <= maxLines) return lines;
  return [...lines.slice(0, maxLines), `... [truncated ${lines.length - maxLines} lines]`];
}
