/**
 * @los/agent/tools — Tool registry and built-in tools.
 *
 * Inspired by pi's createCodingTools and lsclaw's BUILT_IN_HANDLERS.
 * MVP tools: read_file, write_file, edit_file, run_shell, list_directory.
 */

import { getLogger } from '@los/infra/logger';
import type { ToolDef } from '../../providers/index.js';
import { readFileSync, writeFileSync } from 'node:fs';
import { readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { safeWorkspacePath } from './path-safety.js';
import { registerPatchTools } from '../builtin/patch-tools.js';
import { registerTodoTools } from '../builtin/todo-tools.js';
import { runSandboxedShell } from '../external/shell-sandbox.js';
import {
  MCPToolBridge,
  registryRecordToConfig,
  type MCPServerConfig,
} from '../external/mcp-client.js';
import { registerSearchTools } from '../builtin/search-tools.js';
import { registerFileTools } from '../builtin/file-tools.js';
import { registerCodeIntelTools } from '../builtin/code-intel.js';
import { registerEditTools } from '../builtin/edit-tools.js';
import { registerWebTools } from '../external/web-tools.js';
import { registerJobTools } from '../builtin/job-tools.js';
import {
  READ_ONLY_BUILTIN_TOOLS,
  checkCapability,
  executeWithRetry,
  normalizeCapability,
} from './registry-policy.js';
import type {
  BuiltinToolOptions,
  ToolCapability,
  ToolExecutionDecision,
  ToolHandler,
  ToolInput,
  ToolRegistry,
  ToolRegistryOptions,
  ToolResult,
} from './registry-policy.js';

const log = getLogger('agent');

export { READ_ONLY_BUILTIN_TOOLS } from './registry-policy.js';
export type {
  BuiltinToolOptions,
  ToolCapability,
  ToolCostLevel,
  ToolExecutionDecision,
  ToolExecutionPolicy,
  ToolExecutionReasonCode,
  ToolHandler,
  ToolInput,
  ToolRegistry,
  ToolRegistryOptions,
  ToolResult,
  ToolRetryPolicy,
  ToolRiskLevel,
} from './registry-policy.js';

// ── Registry ─────────────────────────────────────────────

export function createToolRegistry(options: ToolRegistryOptions = {}): ToolRegistry {
  const handlers = new Map<string, ToolHandler>();
  const definitions = new Map<string, ToolDef>();
  const capabilities = new Map<string, ToolCapability>();
  const allowedTools = options.allowedTools ? new Set(options.allowedTools) : null;
  const policy = options.policy ?? {};

  const isAllowed = (name: string) => allowedTools === null || allowedTools.has(name);

  return {
    register(name: string, handler: ToolHandler, def: ToolDef, capability?: Partial<ToolCapability>) {
      if (!isAllowed(name)) {
        log.debug(`Skipped tool by policy: ${name}`);
        return;
      }
      handlers.set(name, handler);
      definitions.set(name, def);
      capabilities.set(name, normalizeCapability(name, capability));
      log.debug(`Registered tool: ${name}`);
    },

    async execute(input: ToolInput): Promise<ToolResult> {
      const decision = this.evaluateTool(input.name);
      if (!decision.allowed) return { content: '', error: decision.reason };

      const handler = handlers.get(input.name);
      if (!handler) {
        return { content: '', error: `Unknown tool: ${input.name}` };
      }
      return await executeWithRetry(input, handler, decision.capability, policy);
    },

    evaluateTool(name: string): ToolExecutionDecision {
      if (!isAllowed(name)) {
        return {
          allowed: false,
          reasonCode: 'tool_not_allowed',
          reason: `Tool not allowed: ${name}`,
          policy,
        };
      }

      const capability = capabilities.get(name);
      const capabilityCheck = checkCapability(capability, policy);
      if (!capabilityCheck.allowed) {
        return { ...capabilityCheck, capability, policy };
      }

      return { allowed: true, capability: capabilityCheck.capability, policy };
    },

    getDefinitions(): ToolDef[] {
      return [...definitions.values()];
    },

    getCapabilities(): ToolCapability[] {
      return [...capabilities.values()];
    },

    getCapability(name: string): ToolCapability | null {
      return capabilities.get(name) ?? null;
    },

    list(): string[] {
      return [...handlers.keys()];
    },
  };
}

// ── Built-in Tools ───────────────────────────────────────

export function setWorkspaceRoot(_root: string): never {
  throw new Error('setWorkspaceRoot is no longer supported. Pass workspaceRoot to runAgent() or registerBuiltinTools().');
}

export async function registerBuiltinTools(
  registry: ToolRegistry,
  options: BuiltinToolOptions = {},
): Promise<() => Promise<void>> {
  const workspaceRoot = resolve(options.workspaceRoot ?? process.cwd());

  // read_file
  registry.register('read_file', async (args) => {
    const path = safeWorkspacePath(workspaceRoot, String(args.path ?? ''));
    const range = args.range as string | undefined;
    const head = args.head as number | undefined;

    let content = readFileSync(path, 'utf-8');
    const lines = content.split('\n');

    if (range) {
      const [start, end] = range.split('-').map(Number);
      content = lines.slice(start - 1, end).join('\n');
    } else if (head) {
      content = lines.slice(0, head).join('\n');
    }

    return { content };
  }, {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read a file from the workspace. Use range (e.g. "10-50") or head to limit output.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path relative to workspace' },
          range: { type: 'string', description: 'Line range, e.g. "10-50"' },
          head: { type: 'number', description: 'Return first N lines' },
        },
        required: ['path'],
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

  // write_file
  registry.register('write_file', async (args) => {
    const path = safeWorkspacePath(workspaceRoot, String(args.path ?? ''));
    const content = String(args.content ?? '');
    writeFileSync(path, content, 'utf-8');
    return { content: `Wrote ${content.split('\n').length} lines to ${path}` };
  }, {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Create or overwrite a file in the workspace.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path relative to workspace' },
          content: { type: 'string', description: 'File content' },
        },
        required: ['path', 'content'],
      },
    },
  }, {
    riskLevel: 'L1',
    permissions: ['workspace:write'],
    timeoutMs: 60_000,
    retryable: false,
    idempotent: false,
    costLevel: 'low',
    sideEffect: true,
    tags: ['io', 'write'],
  });

  // run_shell
  registry.register('run_shell', async (args) => {
    const command = String(args.command ?? '');
    const cwd = args.cwd ? safeWorkspacePath(workspaceRoot, String(args.cwd)) : workspaceRoot;
    const requestedTimeout = Number(args.timeoutSec ?? 30);
    const timeout = Math.max(1, Math.min(Number.isFinite(requestedTimeout) ? requestedTimeout : 30, 300));

    const result = await runSandboxedShell({
      command,
      cwd,
      timeoutMs: timeout * 1000,
    });
    return result.error
      ? { content: result.content, error: result.error }
      : { content: result.content };
  }, {
    type: 'function',
    function: {
      name: 'run_shell',
      description: 'Execute a shell command. Use for build, test, lint, git, or file operations.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Shell command to execute' },
          cwd: { type: 'string', description: 'Working directory (default: workspace root)' },
          timeoutSec: { type: 'number', description: 'Timeout in seconds (default: 30)' },
        },
        required: ['command'],
      },
    },
  }, {
    riskLevel: 'L2',
    permissions: ['workspace:shell'],
    timeoutMs: 300_000,
    retryable: false,
    idempotent: false,
    costLevel: 'high',
    sideEffect: true,
    sandboxRequired: true,
    needsApproval: true,
    tags: ['shell'],
  });

  // list_directory
  registry.register('list_directory', async (args) => {
    const path = safeWorkspacePath(workspaceRoot, String(args.path ?? '.'));
    const entries = readdirSync(path, { withFileTypes: true });
    const lines = entries.map(e => {
      const suffix = e.isDirectory() ? '/' : '';
      let size = '';
      if (!e.isDirectory()) {
        try { size = ` (${statSync(join(path, e.name)).size} bytes)`; } catch {}
      }
      return `${e.name}${suffix}${size}`;
    });
    return { content: lines.join('\n') || '(empty directory)' };
  }, {
    type: 'function',
    function: {
      name: 'list_directory',
      description: 'List files and directories in a path. Directories marked with /.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Directory path relative to workspace (default: .)' },
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

  registerPatchTools(registry, { workspaceRoot });
  registerTodoTools(registry);
  registerSearchTools(registry, { workspaceRoot });
  registerFileTools(registry, { workspaceRoot });
  registerCodeIntelTools(registry, { workspaceRoot });
  registerEditTools(registry, { workspaceRoot });
  registerWebTools(registry);
  registerJobTools(registry, { workspaceRoot });

  // ── MCP external tools ───────────────────────────────
  let mcpCleanup: (() => Promise<void>) | undefined;

  // Build tool → server ID map for event metadata
  const mcpToolServerMap = new Map<string, string>();

  // Merge registry records + request-level configs
  const registryConfigs = (options.mcpRegistryRecords ?? [])
    .map(registryRecordToConfig)
    .filter((c): c is MCPServerConfig => c !== null);
  const requestConfigs = options.mcpServers ?? [];
  const allMCPConfigs = [...registryConfigs, ...requestConfigs];

  if (allMCPConfigs.length > 0) {
    const bridge = new MCPToolBridge();
    await bridge.connect(allMCPConfigs);

    const toolDefs = bridge.getToolDefs();
    for (const toolDef of toolDefs) {
      const name = toolDef.name;
      const client = bridge.getClient(name);
      if (!client) continue;

      // Determine which server this tool belongs to (for event tracking)
      // Map from the registry records first, then request configs
      mcpToolServerMap.set(name, 'mcp');

      registry.register(
        name,
        async (args) => {
          try {
            const result = await client.callTool(name, args);
            return { content: result };
          } catch (err: any) {
            return { content: '', error: err?.message ?? String(err) };
          }
        },
        {
          type: 'function',
          function: {
            name,
            description: toolDef.description ?? `MCP tool: ${name}`,
            parameters: toolDef.inputSchema,
          },
        },
        {
          riskLevel: 'L1',
          permissions: ['mcp:external'],
          timeoutMs: 60_000,
          retryable: false,
          idempotent: false,
          costLevel: 'medium',
          sideEffect: true,
          tags: ['mcp', 'external'],
        },
      );
    }

    log.info(
      `Registered ${toolDefs.length} MCP tools from ${allMCPConfigs.length} server(s)`,
    );

    mcpCleanup = async () => {
      await bridge.close();
    };
  }

  return mcpCleanup ?? (async () => {});
}
