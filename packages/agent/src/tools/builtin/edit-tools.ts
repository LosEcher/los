/**
 * @los/agent/tools/edit-tools — Advanced editing operations.
 *
 * multi_edit: N SEARCH/REPLACE edits across multiple files, atomic validation.
 * delete_range: delete a contiguous text range by exact anchor text.
 * delete_symbol: delete a function/class/method/interface/type by name via AST.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import type { ToolRegistry } from '../core/registry.js';
import { safeWorkspacePath } from '../core/path-safety.js';
import {
  LANG_EXTS,
  findSymbolNodes,
  normalizeSymbolKind,
  cleanupWhitespace,
  getLangForExt,
} from '../helpers/edit-ast-helpers.js';

// ── multi_edit ──────────────────────────────────────────

interface MultiEditEntry {
  path: string;
  search: string;
  replace: string;
}

export function registerMultiEditTool(
  registry: ToolRegistry,
  options: { workspaceRoot: string },
): void {
  registry.register('multi_edit', async (rawArgs) => {
    const args = rawArgs as Record<string, unknown>;
    const edits = normalizeMultiEdits(args.edits);
    if (!edits || edits.length === 0) {
      return { content: '', error: 'edits is required (array of {path, search, replace})' };
    }

    // Phase 1: Validate all edits
    const originals = new Map<string, string>();
    const errors: string[] = [];

    for (let i = 0; i < edits.length; i++) {
      const edit = edits[i]!;
      const absPath = safeWorkspacePath(options.workspaceRoot, edit.path);

      // Read file (only once per file)
      let content = originals.get(absPath);
      if (content === undefined) {
        try {
          content = readFileSync(absPath, 'utf-8');
        } catch (err: any) {
          errors.push(`edit ${i + 1} [${edit.path}]: cannot read file: ${err?.message ?? String(err)}`);
          continue;
        }
        originals.set(absPath, content);
      }

      // Account for previous edits applied to the same file
      const currentContent = getCurrentContent(absPath, content, edits, i);

      // Verify search text exists and is unique
      const first = currentContent.indexOf(edit.search);
      if (first < 0) {
        errors.push(`edit ${i + 1} [${edit.path}]: search text not found in file`);
        continue;
      }
      const second = currentContent.indexOf(edit.search, first + 1);
      if (second >= 0) {
        errors.push(`edit ${i + 1} [${edit.path}]: search text is not unique (appears multiple times)`);
        continue;
      }
    }

    if (errors.length > 0) {
      return { content: '', error: `Validation failed:\n${errors.join('\n')}` };
    }

    // Phase 2: Apply edits
    const fileContents = new Map<string, string>();
    const applied: string[] = [];

    try {
      for (let i = 0; i < edits.length; i++) {
        const edit = edits[i]!;
        const absPath = safeWorkspacePath(options.workspaceRoot, edit.path);

        let content = fileContents.get(absPath);
        if (content === undefined) {
          content = originals.get(absPath) ?? readFileSync(absPath, 'utf-8');
        }

        const idx = content.indexOf(edit.search);
        content = content.slice(0, idx) + edit.replace + content.slice(idx + edit.search.length);
        fileContents.set(absPath, content);

        applied.push(`edit ${i + 1}: ${edit.path} — ${countLines(edit.search)}→${countLines(edit.replace)} lines`);
      }

      // Write all files
      for (const [absPath, content] of fileContents) {
        writeFileSync(absPath, content, 'utf-8');
      }

      return { content: `${applied.length} edit(s) applied across ${fileContents.size} file(s):\n${applied.join('\n')}` };
    } catch (err: any) {
      // Attempt rollback: restore original content
      for (const [absPath, original] of originals) {
        try { writeFileSync(absPath, original, 'utf-8'); } catch {}
      }
      return { content: '', error: `Apply failed (rolled back): ${err?.message ?? String(err)}` };
    }
  }, {
    type: 'function',
    function: {
      name: 'multi_edit',
      description:
        'Apply N SEARCH/REPLACE edits across one or more files in a single call. ' +
        'All edits validate before any file is written. ' +
        'Per-file edits run in array order, so later edits can match text inserted by earlier ones. ' +
        'Each search string must appear exactly once in its target file at apply time.',
      parameters: {
        type: 'object',
        properties: {
          edits: {
            type: 'array',
            description: 'Edits to apply in order.',
            items: {
              type: 'object',
              properties: {
                path: { type: 'string', description: 'File path relative to workspace.' },
                search: { type: 'string', description: 'Exact text to find (must be unique in file).' },
                replace: { type: 'string', description: 'Replacement text.' },
              },
              required: ['path', 'search', 'replace'],
            },
          },
        },
        required: ['edits'],
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
    tags: ['edit', 'write'],
  });
}

function getCurrentContent(
  absPath: string,
  original: string,
  edits: MultiEditEntry[],
  currentIndex: number,
): string {
  let content = original;
  for (let j = 0; j < currentIndex; j++) {
    const prev = edits[j]!;
    if (safeWorkspacePathNoThrow(prev.path) === absPath) {
      const idx = content.indexOf(prev.search);
      if (idx >= 0) {
        content = content.slice(0, idx) + prev.replace + content.slice(idx + prev.search.length);
      }
    }
  }
  return content;
}

function safeWorkspacePathNoThrow(userPath: string): string {
  try {
    return safeWorkspacePath('.', userPath);
  } catch {
    return userPath;
  }
}

// ── delete_range ────────────────────────────────────────

export function registerDeleteRangeTool(
  registry: ToolRegistry,
  options: { workspaceRoot: string },
): void {
  registry.register('delete_range', async (rawArgs) => {
    const args = rawArgs as Record<string, unknown>;
    const filePath = safeWorkspacePath(options.workspaceRoot, String(args.path ?? ''));
    const startAnchor = String(args.start_anchor ?? '');
    const endAnchor = String(args.end_anchor ?? '');
    const inclusive = args.inclusive !== false; // default true

    if (!startAnchor || !endAnchor) {
      return { content: '', error: 'start_anchor and end_anchor are required' };
    }

    let content: string;
    try {
      content = readFileSync(filePath, 'utf-8');
    } catch (err: any) {
      return { content: '', error: `Cannot read file: ${err?.message ?? String(err)}` };
    }

    // Find start anchor
    const startIdx = content.indexOf(startAnchor);
    if (startIdx < 0) {
      return { content: '', error: 'start_anchor not found in file' };
    }
    if (content.indexOf(startAnchor, startIdx + 1) >= 0) {
      return { content: '', error: 'start_anchor appears multiple times' };
    }

    // Find end anchor (must appear after start anchor)
    const searchFrom = startIdx + (inclusive ? 0 : startAnchor.length);
    const endIdx = content.indexOf(endAnchor, searchFrom);
    if (endIdx < 0) {
      return { content: '', error: 'end_anchor not found after start_anchor' };
    }
    if (content.indexOf(endAnchor, endIdx + 1) >= 0) {
      return { content: '', error: 'end_anchor appears multiple times' };
    }

    // Calculate delete range
    const deleteStart = inclusive ? startIdx : startIdx + startAnchor.length;
    const deleteEnd = inclusive ? endIdx + endAnchor.length : endIdx;

    const newContent = content.slice(0, deleteStart) + content.slice(deleteEnd);
    writeFileSync(filePath, newContent, 'utf-8');

    const deletedLines = countLines(content.slice(deleteStart, deleteEnd));
    return { content: `Deleted ${deletedLines} lines from ${args.path}` };
  }, {
    type: 'function',
    function: {
      name: 'delete_range',
      description:
        'Delete a contiguous text range using exact start/end anchor text. ' +
        'If inclusive (default true), deletes the anchors too. ' +
        'Fails if either anchor is missing or appears multiple times.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path relative to workspace.' },
          start_anchor: { type: 'string', description: 'Exact text marking the start of the range.' },
          end_anchor: { type: 'string', description: 'Exact text marking the end of the range.' },
          inclusive: { type: 'boolean', description: 'Delete anchors too? Default true.' },
        },
        required: ['path', 'start_anchor', 'end_anchor'],
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
    tags: ['edit', 'write'],
  });
}

// ── delete_symbol ───────────────────────────────────────

export function registerDeleteSymbolTool(
  registry: ToolRegistry,
  options: { workspaceRoot: string },
): void {
  registry.register('delete_symbol', async (rawArgs) => {
    const args = rawArgs as Record<string, unknown>;
    const filePath = safeWorkspacePath(options.workspaceRoot, String(args.path ?? ''));
    const name = String(args.name ?? '').trim();
    if (!name) return { content: '', error: 'name is required' };

    const ext = filePath.slice(filePath.lastIndexOf('.')).toLowerCase();
    const langKey = LANG_EXTS[ext];
    if (!langKey) {
      return { content: '', error: `Unsupported file type: ${ext}. Supported: .ts, .tsx, .js, .jsx` };
    }

    const kindFilter = normalizeSymbolKind(String(args.kind ?? ''));
    const parentFilter = typeof args.parent === 'string' ? args.parent.trim() || null : null;

    let content: string;
    try {
      content = readFileSync(filePath, 'utf-8');
    } catch (err: any) {
      return { content: '', error: `Cannot read file: ${err?.message ?? String(err)}` };
    }

    // Parse with ast-grep
    const lang = getLangForExt(ext);
    if (!lang) {
      return { content: '', error: `Unsupported file type: ${ext}. Supported: .ts, .tsx, .js, .jsx` };
    }
    const root = lang.parse(content).root();

    // Find matching symbol
    const candidates = findSymbolNodes(root, name, kindFilter, parentFilter);

    if (candidates.length === 0) {
      return { content: '', error: `Symbol "${name}"${kindFilter ? ` (kind: ${kindFilter})` : ''} not found` };
    }
    if (candidates.length > 1) {
      const list = candidates.map(c => {
        const r = c.node.range();
        return `  - ${c.node.kind()} at line ${r.start.line + 1}`;
      }).join('\n');
      return { content: '', error: `Symbol "${name}" is ambiguous. Candidates:\n${list}` };
    }

    // Delete the symbol
    const target = candidates[0]!;
    const range = target.node.range();
    const before = content.slice(0, range.start.index);
    const after = content.slice(range.end.index);
    const newContent = cleanupWhitespace(before, after);

    writeFileSync(filePath, newContent, 'utf-8');

    const deletedLines = content.slice(range.start.index, range.end.index).split('\n').length;
    return { content: `Deleted ${target.node.kind()} "${name}" (${deletedLines} lines) at line ${range.start.line + 1}` };
  }, {
    type: 'function',
    function: {
      name: 'delete_symbol',
      description:
        'Delete a function/class/method/interface/type by exact symbol name using AST parsing. ' +
        'Fails with candidates if the name is ambiguous. ' +
        'Supported: .ts, .tsx, .js, .jsx.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path relative to workspace.' },
          name: { type: 'string', description: 'Exact symbol name to delete.' },
          kind: { type: 'string', enum: ['function', 'class', 'method', 'interface', 'type'], description: 'Optional symbol kind filter.' },
          parent: { type: 'string', description: 'Optional parent class/namespace name filter.' },
        },
        required: ['path', 'name'],
      },
    },
  }, {
    riskLevel: 'L1',
    permissions: ['workspace:write'],
    timeoutMs: 15_000,
    retryable: false,
    idempotent: false,
    costLevel: 'low',
    sideEffect: true,
    tags: ['edit', 'write', 'ast'],
  });
}

// ── Helpers ─────────────────────────────────────────────

function normalizeMultiEdits(value: unknown): MultiEditEntry[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const edits: MultiEditEntry[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const e = item as Record<string, unknown>;
    const path = typeof e.path === 'string' ? e.path.trim() : '';
    const search = typeof e.search === 'string' ? e.search : '';
    const replace = typeof e.replace === 'string' ? e.replace : '';
    if (!path || !search) continue;
    edits.push({ path, search, replace });
  }
  return edits.length > 0 ? edits : null;
}

function countLines(text: string): number {
  if (text.length === 0) return 0;
  return text.split('\n').length;
}

// ── Bulk Registration ───────────────────────────────────

export function registerEditTools(
  registry: ToolRegistry,
  options: { workspaceRoot: string },
): void {
  registerMultiEditTool(registry, options);
  registerDeleteRangeTool(registry, options);
  registerDeleteSymbolTool(registry, options);
}
