/**
 * @los/agent/tools/directory-tree-tool — Recursive directory tree listing tool.
 *
 * Extracted from file-tools.ts to keep both files under 400 lines.
 */

import { readdirSync } from 'node:fs';
import { join } from 'node:path';
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

// ── Helpers ─────────────────────────────────────────────

function indent(depth: number): string {
  return '  '.repeat(depth);
}

function clampDepth(value: number): number {
  if (!Number.isFinite(value) || value < 0) return MAX_DEPTH_DEFAULT;
  return Math.min(Math.floor(value), 10);
}
