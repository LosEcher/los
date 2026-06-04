/**
 * @los/agent/tools/file-tools — Filesystem inspection and management tools.
 *
 * directory_tree: recursive tree output with depth control.
 * get_file_info: stat a path, return type/size/mtime.
 * delete_file: remove a single file.
 * create_directory: mkdir -p equivalent.
 * copy_file: copy a file or directory.
 * move_file: rename/move a file or directory.
 */

import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmdirSync,
  statSync,
  unlinkSync,
} from 'node:fs';
import { join, relative, resolve } from 'node:path';
import type { ToolRegistry } from './registry.js';
import { safeWorkspacePath } from './path-safety.js';

// ── Constants ───────────────────────────────────────────

const SKIP_DIRS = new Set([
  'node_modules', '.git', '.hg', '.svn',
  'dist', 'build', 'out', 'target',
  '.next', '.nuxt', '.turbo', '.vercel',
  '__pycache__', '.mypy_cache', '.pytest_cache',
  '.cache', '.venv', 'venv', '.devenv', '.direnv',
  'coverage',
]);

const MAX_DEPTH_DEFAULT = 2;
const FOLD_THRESHOLD = 50;

// ── directory_tree ──────────────────────────────────────

export function registerDirectoryTreeTool(
  registry: ToolRegistry,
  options: { workspaceRoot: string },
): void {
  registry.register('directory_tree', async (rawArgs) => {
    const args = rawArgs as Record<string, unknown>;
    const targetPath = safeWorkspacePath(
      options.workspaceRoot,
      typeof args.path === 'string' ? args.path : '.',
    );
    const maxDepth = clampDepth(Number(args.maxDepth ?? MAX_DEPTH_DEFAULT));

    const lines: string[] = [];
    buildTree(targetPath, targetPath, 0, maxDepth, lines);
    return { content: lines.join('\n') || '(empty)' };
  }, {
    type: 'function',
    function: {
      name: 'directory_tree',
      description:
        'Recursively list entries with indented tree structure (dirs marked "/"). ' +
        'Budget-aware: maxDepth defaults to 2, large subtrees (>50 children) auto-collapse. ' +
        'Skips node_modules, .git, dist, etc.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Root of the tree (default: workspace root).' },
          maxDepth: { type: 'number', description: 'Max recursion depth. Default 2, 0 = top-level only.' },
        },
        required: [],
      },
    },
  }, {
    riskLevel: 'L0',
    permissions: ['workspace:read'],
    timeoutMs: 30_000,
    retryable: true,
    idempotent: true,
    costLevel: 'low',
    sideEffect: false,
    tags: ['io', 'read'],
  });
}

function buildTree(
  root: string,
  dir: string,
  depth: number,
  maxDepth: number,
  lines: string[],
): void {
  if (depth > maxDepth) return;

  let entries: Array<{ name: string; isDirectory(): boolean }>;
  try {
    entries = readdirSync(dir, { withFileTypes: true }) as unknown as Array<{ name: string; isDirectory(): boolean }>;
  } catch {
    lines.push(`${indent(depth)}[unreadable]`);
    return;
  }

  // Sort: dirs first, then files, alphabetical
  entries.sort((a, b) => {
    if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  const indentStr = indent(depth);

  if (entries.length > FOLD_THRESHOLD && depth < maxDepth) {
    // Auto-collapse: show only first 10 and count
    for (let i = 0; i < Math.min(10, entries.length); i++) {
      const entry = entries[i]!;
      if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue;
      if (entry.isDirectory()) {
        lines.push(`${indentStr}${entry.name}/`);
        if (depth < maxDepth) {
          buildTree(root, join(dir, entry.name), depth + 1, maxDepth, lines);
        }
      } else {
        lines.push(`${indentStr}${entry.name}`);
      }
    }
    const remaining = entries.length - 10;
    if (remaining > 0) {
      lines.push(`${indentStr}[${remaining} hidden — list_directory to inspect]`);
    }
    return;
  }

  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      lines.push(`${indentStr}${entry.name}/`);
      if (depth < maxDepth) {
        buildTree(root, join(dir, entry.name), depth + 1, maxDepth, lines);
      }
    } else {
      lines.push(`${indentStr}${entry.name}`);
    }
  }
}

function indent(depth: number): string {
  return '  '.repeat(depth);
}

// ── get_file_info ───────────────────────────────────────

export function registerGetFileInfoTool(
  registry: ToolRegistry,
  options: { workspaceRoot: string },
): void {
  registry.register('get_file_info', async (rawArgs) => {
    const args = rawArgs as Record<string, unknown>;
    const targetPath = safeWorkspacePath(
      options.workspaceRoot,
      String(args.path ?? '.'),
    );

    let stat: ReturnType<typeof statSync>;
    try {
      stat = statSync(targetPath);
    } catch (err: any) {
      return { content: '', error: `Cannot stat: ${err?.message ?? String(err)}` };
    }

    const type = stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : stat.isSymbolicLink() ? 'symlink' : 'other';
    const info = {
      type,
      size: stat.size,
      mtime: stat.mtime.toISOString(),
      birthtime: stat.birthtime.toISOString(),
    };

    return { content: JSON.stringify(info, null, 2) };
  }, {
    type: 'function',
    function: {
      name: 'get_file_info',
      description: 'Retrieve detailed metadata about a file or directory. Returns type, size in bytes, modification time.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path to stat (relative to workspace).' },
        },
        required: ['path'],
      },
    },
  }, {
    riskLevel: 'L0',
    permissions: ['workspace:read'],
    timeoutMs: 10_000,
    retryable: true,
    idempotent: true,
    costLevel: 'low',
    sideEffect: false,
    tags: ['io', 'read'],
  });
}

// ── delete_file ─────────────────────────────────────────

export function registerDeleteFileTool(
  registry: ToolRegistry,
  options: { workspaceRoot: string },
): void {
  registry.register('delete_file', async (rawArgs) => {
    const args = rawArgs as Record<string, unknown>;
    const targetPath = safeWorkspacePath(
      options.workspaceRoot,
      String(args.path ?? ''),
    );

    if (!existsSync(targetPath)) {
      return { content: '', error: `File not found: ${args.path}` };
    }

    const stat = statSync(targetPath);
    if (stat.isDirectory()) {
      return { content: '', error: 'Use delete_directory for directories (not delete_file)' };
    }

    unlinkSync(targetPath);
    return { content: `Deleted: ${args.path}` };
  }, {
    type: 'function',
    function: {
      name: 'delete_file',
      description: 'Delete a single file. Refuses to delete directories — use a separate tool for that.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path to the file to delete (relative to workspace).' },
        },
        required: ['path'],
      },
    },
  }, {
    riskLevel: 'L1',
    permissions: ['workspace:write'],
    timeoutMs: 10_000,
    retryable: false,
    idempotent: false,
    costLevel: 'low',
    sideEffect: true,
    tags: ['io', 'write'],
  });
}

// ── create_directory ────────────────────────────────────

export function registerCreateDirectoryTool(
  registry: ToolRegistry,
  options: { workspaceRoot: string },
): void {
  registry.register('create_directory', async (rawArgs) => {
    const args = rawArgs as Record<string, unknown>;
    const targetPath = safeWorkspacePath(
      options.workspaceRoot,
      String(args.path ?? ''),
    );

    if (!args.path || String(args.path).trim() === '') {
      return { content: '', error: 'path is required' };
    }

    mkdirSync(targetPath, { recursive: true });
    return { content: `Created directory: ${args.path}` };
  }, {
    type: 'function',
    function: {
      name: 'create_directory',
      description: 'Create a directory (and any missing parents). Succeeds silently if already exists.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Directory path relative to workspace.' },
        },
        required: ['path'],
      },
    },
  }, {
    riskLevel: 'L1',
    permissions: ['workspace:write'],
    timeoutMs: 10_000,
    retryable: false,
    idempotent: true,
    costLevel: 'low',
    sideEffect: true,
    tags: ['io', 'write'],
  });
}

// ── Bulk Registration ───────────────────────────────────

export function registerCopyFileTool(
  registry: ToolRegistry,
  options: { workspaceRoot: string },
): void {
  registry.register('copy_file', async (rawArgs) => {
    const args = rawArgs as Record<string, unknown>;
    const source = safeWorkspacePath(options.workspaceRoot, String(args.source ?? ''));
    const destination = safeWorkspacePath(options.workspaceRoot, String(args.destination ?? ''));

    if (!args.source || !args.destination) {
      return { content: '', error: 'source and destination are required' };
    }

    if (!existsSync(source)) {
      return { content: '', error: `Source not found: ${args.source}` };
    }
    if (existsSync(destination)) {
      return { content: '', error: `Destination already exists: ${args.destination}` };
    }

    // Ensure parent directory exists
    const destDir = destination.slice(0, destination.lastIndexOf('/'));
    if (destDir && !existsSync(destDir)) {
      mkdirSync(destDir, { recursive: true });
    }

    try {
      cpSync(source, destination, { recursive: true });
    } catch (err: any) {
      return { content: '', error: `Copy failed: ${err?.message ?? String(err)}` };
    }

    return { content: `Copied ${args.source} → ${args.destination}` };
  }, {
    type: 'function',
    function: {
      name: 'copy_file',
      description: 'Copy a file or directory. Parent directories of the destination are created as needed. Refuses to overwrite existing destinations.',
      parameters: {
        type: 'object',
        properties: {
          source: { type: 'string', description: 'Source path relative to workspace.' },
          destination: { type: 'string', description: 'Destination path relative to workspace.' },
        },
        required: ['source', 'destination'],
      },
    },
  }, {
    riskLevel: 'L1',
    permissions: ['workspace:write'],
    timeoutMs: 30_000,
    retryable: false,
    idempotent: false,
    costLevel: 'low',
    sideEffect: true,
    tags: ['io', 'write'],
  });
}

export function registerMoveFileTool(
  registry: ToolRegistry,
  options: { workspaceRoot: string },
): void {
  registry.register('move_file', async (rawArgs) => {
    const args = rawArgs as Record<string, unknown>;
    const source = safeWorkspacePath(options.workspaceRoot, String(args.source ?? ''));
    const destination = safeWorkspacePath(options.workspaceRoot, String(args.destination ?? ''));

    if (!args.source || !args.destination) {
      return { content: '', error: 'source and destination are required' };
    }

    if (!existsSync(source)) {
      return { content: '', error: `Source not found: ${args.source}` };
    }
    if (existsSync(destination)) {
      return { content: '', error: `Destination already exists: ${args.destination}` };
    }

    // Ensure parent directory exists
    const destDir = destination.slice(0, destination.lastIndexOf('/'));
    if (destDir && !existsSync(destDir)) {
      mkdirSync(destDir, { recursive: true });
    }

    try {
      renameSync(source, destination);
    } catch (err: any) {
      return { content: '', error: `Move failed: ${err?.message ?? String(err)}` };
    }

    return { content: `Moved ${args.source} → ${args.destination}` };
  }, {
    type: 'function',
    function: {
      name: 'move_file',
      description: 'Rename/move a file or directory. Parent directories of the destination are created as needed. Refuses to overwrite existing destinations.',
      parameters: {
        type: 'object',
        properties: {
          source: { type: 'string', description: 'Source path relative to workspace.' },
          destination: { type: 'string', description: 'Destination path relative to workspace.' },
        },
        required: ['source', 'destination'],
      },
    },
  }, {
    riskLevel: 'L1',
    permissions: ['workspace:write'],
    timeoutMs: 30_000,
    retryable: false,
    idempotent: false,
    costLevel: 'low',
    sideEffect: true,
    tags: ['io', 'write'],
  });
}

// ── Bulk Registration ───────────────────────────────────

export function registerFileTools(
  registry: ToolRegistry,
  options: { workspaceRoot: string },
): void {
  registerDirectoryTreeTool(registry, options);
  registerGetFileInfoTool(registry, options);
  registerDeleteFileTool(registry, options);
  registerCreateDirectoryTool(registry, options);
  registerCopyFileTool(registry, options);
  registerMoveFileTool(registry, options);
}

// ── Helpers ─────────────────────────────────────────────

function clampDepth(value: number): number {
  if (!Number.isFinite(value) || value < 0) return MAX_DEPTH_DEFAULT;
  return Math.min(Math.floor(value), 10);
}
