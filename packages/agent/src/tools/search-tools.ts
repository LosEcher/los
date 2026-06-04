/**
 * @los/agent/tools/search-tools — Codebase search tools.
 *
 * search_content: recursive grep with regex, glob filter, context lines.
 * search_files: filename substring/regex search.
 * glob: pattern-based file listing with mtime/name sort.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
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

const PER_FILE_HIT_CAP = 30;
const MAX_CONTEXT_LINES = 20;

// ── Helpers ─────────────────────────────────────────────

function walkDir(
  root: string,
  dir: string,
  globPattern: string | null,
  onFile: (absPath: string, relPath: string) => void,
): void {
  let entries: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>;
  try {
    entries = readdirSync(dir, { withFileTypes: true }) as unknown as Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>;
  } catch {
    return; // Permission denied, skip
  }

  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue; // Skip hidden files/dirs

    const absPath = join(dir, entry.name);
    const relPath = relative(root, absPath);

    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walkDir(root, absPath, globPattern, onFile);
    } else if (entry.isFile()) {
      if (globPattern && !matchGlob(relPath, globPattern)) continue;
      try {
        // Quick binary check: skip files that are too large or binary
        const stat = statSync(absPath);
        if (stat.size > 2 * 1024 * 1024) continue; // Skip >2MB
      } catch {
        continue;
      }
      onFile(absPath, relPath);
    }
  }
}

/**
 * Simple glob matching: supports * (single segment), ** (any segments),
 * ? (single char), {a,b} (alternation). Converts glob to regex.
 */
function matchGlob(path: string, pattern: string): boolean {
  // Handle **/ prefix
  if (pattern.includes('**')) {
    return matchGlobRecursive(path, pattern);
  }

  const regex = globToRegex(pattern);
  return regex.test(path);
}

function matchGlobRecursive(path: string, pattern: string): boolean {
  // Split on ** and match each segment
  const parts = pattern.split('**');
  if (parts.length === 1) return matchGlob(path, pattern);

  // If pattern starts with **/, match anywhere in path
  // If pattern ends with /**, match prefix
  // If pattern is **, match everything

  const before = parts[0]!;
  const after = parts[1]!;

  // Simple cases:
  if (pattern === '**' || pattern === '**/*') return true;
  if (pattern.startsWith('**/')) {
    // Match suffix anywhere
    const suffix = pattern.slice(3);
    const regex = globToRegex(suffix);
    // Try matching at every position
    const segments = path.split('/');
    for (let i = 0; i < segments.length; i++) {
      if (regex.test(segments.slice(i).join('/'))) return true;
    }
    return false;
  }
  if (pattern.endsWith('/**')) {
    const prefix = pattern.slice(0, -3);
    const regex = globToRegex(prefix + '/*');
    // Match any path starting with prefix
    const prefixParts = prefix.split('/');
    const pathParts = path.split('/');
    if (pathParts.length < prefixParts.length) return false;
    for (let i = 0; i < prefixParts.length; i++) {
      if (!matchGlob(pathParts[i]!, prefixParts[i]!)) return false;
    }
    return true;
  }

  // Middle **: match prefix then suffix
  const prefixRegex = globToRegex(before);
  const suffixRegex = globToRegex(after);

  // Find where the prefix matches, then check suffix in remainder
  const segments = path.split('/');
  for (let i = segments.length; i >= 0; i--) {
    const left = segments.slice(0, i).join('/');
    const right = segments.slice(i).join('/');
    if (prefixRegex.test(left) && suffixRegex.test(right)) return true;
  }
  return false;
}

function globToRegex(pattern: string): RegExp {
  let regex = '';
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i]!;
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        // ** handled at higher level; treat as .* here
        regex += '.*';
        i += 2;
      } else {
        regex += '[^/]*';
        i += 1;
      }
    } else if (ch === '?') {
      regex += '[^/]';
      i += 1;
    } else if (ch === '{') {
      // Alternation {a,b,c}
      const end = pattern.indexOf('}', i);
      if (end > i) {
        const parts = pattern.slice(i + 1, end).split(',').map(p => escapeRegex(p));
        regex += `(${parts.join('|')})`;
        i = end + 1;
      } else {
        regex += '\\{';
        i += 1;
      }
    } else if (ch === '.') {
      regex += '\\.';
      i += 1;
    } else if ('+^$()[]|\\'.includes(ch)) {
      regex += '\\' + ch;
      i += 1;
    } else {
      regex += ch;
      i += 1;
    }
  }
  return new RegExp(`^${regex}$`);
}

function escapeRegex(s: string): string {
  return s.replace(/[.+^$()|[\]{}]/g, '\\$&');
}

function globToFilenameRegex(pattern: string): RegExp {
  // For filename matching (search_files), the pattern matches filename only
  // and * matches any chars including path separators (since we match against
  // relative paths)
  if (pattern.includes('/')) {
    // Path-aware glob
    return new RegExp(globToRegex(pattern).source);
  }
  // Simple substring/regex for filenames
  return new RegExp(globToRegex(`**/${pattern}`).source + '|' + globToRegex(pattern).source);
}

function isSubstringPattern(pattern: string): boolean {
  return !/[*?{[\]\\^$()+|]/.test(pattern);
}

// ── search_content ──────────────────────────────────────

interface SearchContentArgs {
  pattern: string;
  path?: string;
  glob?: string;
  case_sensitive?: boolean;
  context?: number;
  summary_only?: boolean;
}

export function registerSearchContentTool(
  registry: ToolRegistry,
  options: { workspaceRoot: string },
): void {
  registry.register('search_content', async (rawArgs) => {
    const args = rawArgs as Record<string, unknown>;
    const pattern = String(args.pattern ?? '');
    if (!pattern.trim()) return { content: '', error: 'pattern is required' };

    const globFilter = typeof args.glob === 'string' ? args.glob.trim() || null : null;
    const caseSensitive = args.case_sensitive === true;
    const contextLines = clampContext(Number(args.context ?? 0));
    const summaryOnly = args.summary_only === true;

    const searchRoot = safeWorkspacePath(
      options.workspaceRoot,
      typeof args.path === 'string' ? args.path : '.',
    );

    // Determine if pattern is regex or literal substring
    const isRegex = !isSubstringPattern(pattern);
    let regex: RegExp;
    try {
      regex = new RegExp(pattern, caseSensitive ? 'g' : 'gi');
    } catch {
      // Treat as literal substring
      const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      regex = new RegExp(escaped, caseSensitive ? 'g' : 'gi');
    }

    const fileHits = new Map<string, string[]>();
    const fileCounts = new Map<string, number>();

    walkDir(searchRoot, searchRoot, globFilter, (absPath, relPath) => {
      let content: string;
      try {
        content = readFileSync(absPath, 'utf-8');
      } catch {
        return; // Binary or unreadable, skip
      }

      const lines = content.split('\n');
      const matches: string[] = [];

      for (let i = 0; i < lines.length; i++) {
        if (regex.test(lines[i]!)) {
          // Reset lastIndex since we're reusing the regex
          regex.lastIndex = 0;

          if (summaryOnly) {
            matches.push('');
          } else if (contextLines > 0) {
            const start = Math.max(0, i - contextLines);
            const end = Math.min(lines.length - 1, i + contextLines);
            for (let j = start; j <= end; j++) {
              const prefix = j === i ? '>' : ' ';
              matches.push(`${prefix} ${j + 1}: ${lines[j]}`);
            }
            matches.push('--');
          } else {
            matches.push(`${i + 1}: ${lines[i]}`);
          }

          if (matches.length >= PER_FILE_HIT_CAP * (contextLines > 0 ? (contextLines * 2 + 2) : 1)) {
            matches.push(`... [truncated, ${PER_FILE_HIT_CAP}+ matches in this file]`);
            return; // Stop processing this file
          }
        }
      }

      if (matches.length > 0) {
        fileHits.set(relPath, matches);
        fileCounts.set(relPath, matches.filter(m => m.startsWith('> ') || /^\d+:/.test(m)).length);
      }
    });

    if (summaryOnly) {
      // Output: rel: N matches per file
      const lines: string[] = [];
      for (const [relPath, count] of [...fileCounts.entries()].sort(([, a], [, b]) => b - a)) {
        lines.push(`${relPath}: ${count} matches`);
      }
      return { content: lines.join('\n') || '(no matches)' };
    }

    // Normal output: file header + matching lines
    const output: string[] = [];
    for (const [relPath, matches] of fileHits) {
      output.push(`\n=== ${relPath} ===`);
      output.push(...matches);
    }

    return { content: output.join('\n').trim() || '(no matches)' };
  }, {
    type: 'function',
    function: {
      name: 'search_content',
      description:
        'Recursively search file CONTENTS for a substring or regex. ' +
        'Returns one match per line as `path:line: text`. ' +
        'Per-file hit cap 30; use summary_only:true for just file-level counts.',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Substring or regex pattern to search for.' },
          path: { type: 'string', description: 'Search root directory (default: workspace root).' },
          glob: { type: 'string', description: 'Optional filename filter (e.g. "*.ts", "src/**/*.test.ts").' },
          case_sensitive: { type: 'boolean', description: 'Case-sensitive search. Default false.' },
          context: { type: 'number', description: 'Lines of context around each match (both sides). Default 0, max 20.' },
          summary_only: { type: 'boolean', description: 'Only show file-level match counts, not line content.' },
        },
        required: ['pattern'],
      },
    },
  }, {
    riskLevel: 'L0',
    permissions: ['workspace:read'],
    timeoutMs: 60_000,
    retryable: true,
    idempotent: true,
    costLevel: 'low',
    sideEffect: false,
    tags: ['search', 'read'],
  });
}

// ── search_files ─────────────────────────────────────────

export function registerSearchFilesTool(
  registry: ToolRegistry,
  options: { workspaceRoot: string },
): void {
  registry.register('search_files', async (rawArgs) => {
    const args = rawArgs as Record<string, unknown>;
    const pattern = String(args.pattern ?? '');
    if (!pattern.trim()) return { content: '', error: 'pattern is required' };

    const searchRoot = safeWorkspacePath(
      options.workspaceRoot,
      typeof args.path === 'string' ? args.path : '.',
    );

    let regex: RegExp;
    if (isSubstringPattern(pattern)) {
      // Case-insensitive substring
      regex = new RegExp(escapeRegex(pattern), 'i');
    } else {
      regex = globToFilenameRegex(pattern);
    }

    const results: string[] = [];
    walkDir(searchRoot, searchRoot, null, (_absPath, relPath) => {
      // Match against the relative path or just the filename
      const filename = relPath.split(sep).pop() ?? relPath;
      if (regex.test(filename) || regex.test(relPath)) {
        results.push(relPath);
      }
    });

    return { content: results.sort().join('\n') || '(no matching files)' };
  }, {
    type: 'function',
    function: {
      name: 'search_files',
      description:
        'Find files whose NAME matches a substring or regex. ' +
        'Case-insensitive. Walks the directory recursively. ' +
        'Skips node_modules, .git, dist, build, etc.',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Substring or regex to match against filenames.' },
          path: { type: 'string', description: 'Directory to start the search at (default: root).' },
        },
        required: ['pattern'],
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
    tags: ['search', 'read'],
  });
}

// ── glob ─────────────────────────────────────────────────

export function registerGlobTool(
  registry: ToolRegistry,
  options: { workspaceRoot: string },
): void {
  registry.register('glob', async (rawArgs) => {
    const args = rawArgs as Record<string, unknown>;
    const pattern = String(args.pattern ?? '');
    if (!pattern.trim()) return { content: '', error: 'pattern is required' };

    const searchRoot = safeWorkspacePath(
      options.workspaceRoot,
      typeof args.path === 'string' ? args.path : '.',
    );

    const sortBy = (typeof args.sort_by === 'string' ? args.sort_by : 'mtime') as 'mtime' | 'name';
    const limit = clampLimit(Number(args.limit ?? 200));

    const results: Array<{ path: string; mtimeMs: number }> = [];
    walkDir(searchRoot, searchRoot, pattern, (absPath, relPath) => {
      try {
        const stat = statSync(absPath);
        results.push({ path: relPath, mtimeMs: stat.mtimeMs });
      } catch {
        results.push({ path: relPath, mtimeMs: 0 });
      }
    });

    // Sort
    if (sortBy === 'mtime') {
      results.sort((a, b) => b.mtimeMs - a.mtimeMs);
    } else {
      results.sort((a, b) => a.path.localeCompare(b.path));
    }

    const limited = results.slice(0, limit);
    return { content: limited.map(r => r.path).join('\n') || '(no matching files)' };
  }, {
    type: 'function',
    function: {
      name: 'glob',
      description:
        'List files matching a glob pattern, sorted by mtime (most-recent first) by default. ' +
        'Supports *, **, ?, {a,b}. Skips node_modules, .git, dist, etc.',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Glob pattern, e.g. "src/**/*.ts", "*.test.ts".' },
          path: { type: 'string', description: 'Base directory to walk (default: workspace root).' },
          sort_by: { type: 'string', enum: ['mtime', 'name'], description: 'Sort order. Default: mtime.' },
          limit: { type: 'number', description: 'Max results. Default 200, max 1000.' },
        },
        required: ['pattern'],
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
    tags: ['search', 'read'],
  });
}

// ── Helpers ──────────────────────────────────────────────

function clampContext(value: number): number {
  if (!Number.isFinite(value) || value < 0) return 0;
  return Math.min(Math.floor(value), MAX_CONTEXT_LINES);
}

function clampLimit(value: number): number {
  if (!Number.isFinite(value) || value < 1) return 200;
  return Math.max(1, Math.min(Math.floor(value), 1000));
}

export function registerSearchTools(
  registry: ToolRegistry,
  options: { workspaceRoot: string },
): void {
  registerSearchContentTool(registry, options);
  registerSearchFilesTool(registry, options);
  registerGlobTool(registry, options);
}
