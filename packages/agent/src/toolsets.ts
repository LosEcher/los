/**
 * Toolset system — composable tool groups for selective tool registration.
 *
 * Inspired by Hermes' toolsets.py. Toolsets define named groups of tools
 * that can be enabled/disabled per session, project, or platform.
 *
 * Configuration:
 *   LOS_ENABLED_TOOLSETS=coding,browser    # comma-separated list
 *   LOS_ENABLED_TOOLSETS=all               # everything
 *   (when unset, defaults to "coding")
 *
 * Posture toolsets ("coding", "review", "chat") are auto-selected based on
 * the execution context but can be overridden.
 */

// ── Tool names ──────────────────────────────────────────
// These must match the `name` field used in registry.register() calls.

export const TOOL_NAMES = {
  // File operations
  read_file: 'read_file',
  write_file: 'write_file',
  list_directory: 'list_directory',
  directory_tree: 'directory_tree',
  get_file_info: 'get_file_info',
  delete_file: 'delete_file',
  create_directory: 'create_directory',
  copy_file: 'copy_file',
  move_file: 'move_file',

  // Search
  search_content: 'search_content',
  search_files: 'search_files',
  glob: 'glob',

  // Editing
  multi_edit: 'multi_edit',
  delete_range: 'delete_range',
  delete_symbol: 'delete_symbol',
  preview_patch: 'preview_patch',
  apply_patch: 'apply_patch',
  edit_file: 'edit_file',

  // Code intelligence
  get_symbols: 'get_symbols',
  find_in_code: 'find_in_code',

  // Shell
  run_shell: 'run_shell',
  run_background: 'run_background',
  job_output: 'job_output',
  stop_job: 'stop_job',
  run_runtime_task: 'run_runtime_task',
  list_jobs: 'list_jobs',

  // Web
  web_search: 'web_search',
  web_fetch: 'web_fetch',
  http_request: 'http_request',

  // SQL
  sql_query: 'sql_query',

  // Planning
  todo_list: 'todo_list',
  todo_create: 'todo_create',
  todo_update: 'todo_update',
  todo_archive: 'todo_archive',
  todo_reopen: 'todo_reopen',
  todo_link_dependency: 'todo_link_dependency',

  // Coordination
  ask_coordinator: 'ask_coordinator',
  escalate: 'escalate',
} as const;

export type ToolName = (typeof TOOL_NAMES)[keyof typeof TOOL_NAMES];

// ── Toolset definition ──────────────────────────────────

export interface ToolsetDefinition {
  /** Human-readable description. */
  description: string;
  /** Direct tools in this toolset. */
  tools: string[];
  /** Other toolsets to include (composition). */
  includes: string[];
  /**
   * Posture toolset: auto-selected based on execution context.
   * Non-posture toolsets are additive (enabled via config).
   */
  posture?: boolean;
  /** Gate: only register when this returns true. Example: "cua-driver installed". */
  gate?: () => boolean;
}

// ── Base toolsets ───────────────────────────────────────

const TOOLSETS: Record<string, ToolsetDefinition> = {
  // ── Atomic toolsets ────────────────────────────────────

  file: {
    description: 'File system operations: read, write, list, tree, info, delete, create, copy, move',
    tools: [
      TOOL_NAMES.read_file, TOOL_NAMES.write_file, TOOL_NAMES.list_directory,
      TOOL_NAMES.directory_tree, TOOL_NAMES.get_file_info, TOOL_NAMES.delete_file,
      TOOL_NAMES.create_directory, TOOL_NAMES.copy_file, TOOL_NAMES.move_file,
    ],
    includes: [],
  },

  search: {
    description: 'Content and file name search: grep, file glob, structured search',
    tools: [TOOL_NAMES.search_content, TOOL_NAMES.search_files, TOOL_NAMES.glob],
    includes: [],
  },

  edit: {
    description: 'Text editing: multi-edit, delete range/symbol, preview/apply patch, edit file',
    tools: [
      TOOL_NAMES.multi_edit, TOOL_NAMES.delete_range, TOOL_NAMES.delete_symbol,
      TOOL_NAMES.preview_patch, TOOL_NAMES.apply_patch, TOOL_NAMES.edit_file,
    ],
    includes: [],
  },

  code_intel: {
    description: 'Code intelligence: symbol extraction, pattern search (TS/JS/TSX/JSX)',
    tools: [TOOL_NAMES.get_symbols, TOOL_NAMES.find_in_code],
    includes: [],
  },

  shell: {
    description: 'Shell execution: run commands, background jobs, job management',
    tools: [
      TOOL_NAMES.run_shell, TOOL_NAMES.run_background,
      TOOL_NAMES.job_output, TOOL_NAMES.stop_job, TOOL_NAMES.list_jobs,
    ],
    includes: [],
  },

  runtime: {
    description: 'External agent runtimes: delegate tasks to Claude Code, Codex, or Grok CLIs (approval required)',
    tools: [TOOL_NAMES.run_runtime_task],
    includes: [],
  },

  web: {
    description: 'Web access: search (DuckDuckGo), fetch (HTTP GET), request (full HTTP client)',
    tools: [TOOL_NAMES.web_search, TOOL_NAMES.web_fetch, TOOL_NAMES.http_request],
    includes: [],
  },

  planning: {
    description: 'Task planning: create, list, update, archive, reopen, link todos',
    tools: [
      TOOL_NAMES.todo_list, TOOL_NAMES.todo_create, TOOL_NAMES.todo_update,
      TOOL_NAMES.todo_archive, TOOL_NAMES.todo_reopen, TOOL_NAMES.todo_link_dependency,
    ],
    includes: [],
  },

  coordination: {
    description: 'Agent coordination: ask coordinator, escalate to operator',
    tools: [TOOL_NAMES.ask_coordinator, TOOL_NAMES.escalate],
    includes: [],
  },

  /**
   * Browser automation tools — auto-started via MCP stdio.
   *
   * When this toolset is enabled and no externally registered MCP server
   * provides browser tools, los auto-starts @executeautomation/playwright-mcp-server
   * (25+ tools: navigate, click, type, screenshot, evaluate, iframe, drag,
   * keyboard, tab switching, console logs, PDF export). Zero configuration needed.
   *
   * Configuration (environment variables):
   *   LOS_BROWSER_HEADLESS=true   # default: true  (set false for visible browser)
   *   LOS_BROWSER_ENGINE=chromium # default: chromium (or firefox, webkit)
   *
   * To use a different browser MCP server, register it manually via the
   * MCP Servers page — manually registered servers take precedence over auto-start.
   *
   * Tool names use the playwright_* prefix (e.g. playwright_navigate). Both
   * playwright_* and puppeteer_* tools are matched via prefix when this
   * toolset is enabled.
   */
  browser: {
    description: 'Browser automation via MCP: navigate, click, type, scroll, screenshot, console',
    tools: [
      // playwright prefix — matches all playwright_* tools from auto-started server
      'playwright',
      // puppeteer prefix — backward compat for manually registered puppeteer servers
      'puppeteer',
    ],
    includes: [],
  },

  sql: {
    description: 'Read-only SQL queries against the los database (SELECT/WITH only, write operations blocked)',
    tools: [TOOL_NAMES.sql_query],
    includes: [],
  },

  // ── Composite toolsets ─────────────────────────────────

  minimal: {
    description: 'Minimal safe toolset: files, search, web, planning. No shell or edit.',
    tools: [],
    includes: ['file', 'search', 'web', 'planning'],
  },

  coding: {
    description: 'Full coding toolset: files, shell, edit, search, code intel, web, planning, coordination. Default.',
    tools: [],
    includes: ['file', 'shell', 'edit', 'search', 'code_intel', 'web', 'planning', 'coordination', 'runtime'],
    posture: true,
  },

  review: {
    description: 'Review posture: read-only files, search, code intel, web. No writes or shell.',
    tools: [],
    includes: ['search', 'code_intel', 'web'],
    posture: true,
  },

  chat: {
    description: 'Conversational posture: web search, planning only. No files or shell.',
    tools: [],
    includes: ['web', 'planning'],
    posture: true,
  },
};

// ── Resolution ──────────────────────────────────────────

/**
 * Resolve a toolset name to its full list of tool names.
 * Handles composition via `includes`, cycle detection, and `all`/* aliases.
 */
export function resolveToolset(name: string, visited = new Set<string>()): string[] {
  if (name === 'all' || name === '*') {
    const all: Set<string> = new Set();
    for (const key of Object.keys(TOOLSETS)) {
      if (TOOLSETS[key]!.posture) continue; // skip posture-only toolsets
      for (const tool of resolveToolset(key, new Set(visited))) {
        all.add(tool);
      }
    }
    return [...all].sort();
  }

  if (visited.has(name)) return [];
  visited.add(name);

  const def = TOOLSETS[name];
  if (!def) {
    // Unknown toolset names are treated as MCP server toolsets.
    // MCP tools are grouped under their server id; the actual tool names
    // are discovered at runtime. Return the name as a marker.
    return [name];
  }

  const tools = new Set(def.tools);
  for (const included of def.includes) {
    for (const tool of resolveToolset(included, visited)) {
      tools.add(tool);
    }
  }

  return [...tools].sort();
}

/**
 * Resolve multiple toolset names and return the union of all their tools.
 */
export function resolveToolsets(names: string[]): string[] {
  const all = new Set<string>();
  for (const name of names) {
    for (const tool of resolveToolset(name)) {
      all.add(tool);
    }
  }
  return [...all].sort();
}

/**
 * Get the default enabled toolsets from configuration.
 * Checks AGENT_ENABLED_TOOLSETS first, then LOS_ENABLED_TOOLSETS, falls back to "coding".
 */
export function getEnabledToolsets(configOverride?: string): string[] {
  const raw = configOverride
    ?? process.env.AGENT_ENABLED_TOOLSETS
    ?? process.env.LOS_ENABLED_TOOLSETS;
  if (!raw || !raw.trim()) return ['coding'];
  return raw.split(',').map(s => s.trim()).filter(Boolean);
}

/**
 * Check if a tool name is enabled by the given toolset configuration.
 *
 * Matching order:
 *   1. Direct tool name match (built-in tools)
 *   2. Tool name prefix matches an enabled toolset name (e.g. "puppeteer_*" ↔ "puppeteer")
 *   3. Tool belongs to an enabled toolset's resolved tool list
 */
export function isToolEnabled(toolName: string, enabledToolNames: Set<string>): boolean {
  // 1. Direct match
  if (enabledToolNames.has(toolName)) return true;

  // 2. Prefix match: tool name prefix matches an enabled toolset name
  //    Example: "puppeteer_navigate" ↔ toolset "puppeteer" (or "browser" containing puppeteer_*)
  const prefix = toolName.split('_')[0];
  if (prefix && prefix !== toolName && enabledToolNames.has(prefix)) return true;

  // 3. Check if tool is in any enabled composite toolset's resolved list.
  //    This catches cases like browser toolset containing "puppeteer_navigate"
  //    when "browser" is in enabledToolNames but "puppeteer" isn't.
  for (const enabledName of enabledToolNames) {
    const resolved = resolveToolset(enabledName);
    if (resolved.includes(toolName)) return true;
  }

  return false;
}

/**
 * Get the posture toolset name for a given execution context.
 * Returns the toolset name (e.g. "coding") or undefined for default.
 */
export function postureForContext(context: {
  kind?: 'chat' | 'review' | 'coding' | 'execution';
}): string | undefined {
  switch (context.kind) {
    case 'review': return 'review';
    case 'coding':
    case 'execution': return 'coding';
    case 'chat': return 'chat';
    default: return undefined;
  }
}

// ── List available toolsets ─────────────────────────────

export function listToolsets(): Array<{ name: string; description: string; toolCount: number; posture: boolean }> {
  return Object.entries(TOOLSETS).map(([name, def]) => ({
    name,
    description: def.description,
    toolCount: resolveToolset(name).length,
    posture: def.posture ?? false,
  }));
}

export function getToolsetDefinition(name: string): ToolsetDefinition | undefined {
  return TOOLSETS[name];
}
