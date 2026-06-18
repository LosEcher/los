/**
 * @los/agent/tools/file-tools — Filesystem inspection and management tools.
 *
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
  renameSync,
  statSync,
  unlinkSync,
} from 'node:fs';
import type { ToolRegistry } from './registry.js';
import { safeWorkspacePath } from './path-safety.js';
import { registerDirectoryTreeTool } from './directory-tree-tool.js';

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

// ── copy_file ────────────────────────────────────────────

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
