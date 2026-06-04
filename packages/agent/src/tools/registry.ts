/**
 * @los/agent/tools — Tool registry and built-in tools.
 *
 * Inspired by pi's createCodingTools and lsclaw's BUILT_IN_HANDLERS.
 * MVP tools: read_file, write_file, edit_file, run_shell, list_directory.
 */

import { getLogger } from '@los/infra/logger';
import type { ToolDef } from '../providers/index.js';
import { readFileSync, writeFileSync } from 'node:fs';
import { readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { safeWorkspacePath } from './path-safety.js';
import { registerPatchTools } from './patch-tools.js';
import { registerTodoTools } from './todo-tools.js';
import { runSandboxedShell } from './shell-sandbox.js';
import {
  MCPToolBridge,
  registryRecordToConfig,
  type MCPServerConfig,
  type MCPServerRegistryRecord,
} from './mcp-client.js';
import { registerSearchTools } from './search-tools.js';
import { registerFileTools } from './file-tools.js';
import { registerCodeIntelTools } from './code-intel.js';
import { registerEditTools } from './edit-tools.js';

const log = getLogger('agent');

// ── Types ───────────────────────────────────────────────

export interface ToolInput {
  name: string;
  arguments: Record<string, unknown>;
}

export interface ToolResult {
  tool_call_id?: string;
  content: string;
  error?: string;
  attempts?: number;
  retried?: boolean;
  retryErrors?: string[];
}

export type ToolHandler = (args: Record<string, unknown>) => Promise<ToolResult>;

export type ToolRiskLevel = 'L0' | 'L1' | 'L2';
export type ToolCostLevel = 'low' | 'medium' | 'high' | 'critical';
export type ToolExecutionReasonCode =
  | 'tool_not_allowed'
  | 'tool_capability_missing'
  | 'tool_risk_exceeded'
  | 'tool_writes_disabled'
  | 'tool_sandbox_required';

export interface ToolCapability {
  name: string;
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  permissions: string[];
  riskLevel: ToolRiskLevel;
  timeoutMs: number;
  retryable: boolean;
  idempotent: boolean;
  costLevel: ToolCostLevel;
  sideEffect: boolean;
  sandboxRequired: boolean;
  needsApproval: boolean;
  tags: string[];
}

export interface ToolRegistryOptions {
  allowedTools?: readonly string[];
  policy?: ToolExecutionPolicy;
}

export interface BuiltinToolOptions {
  workspaceRoot?: string;
  mcpServers?: MCPServerConfig[];
  mcpRegistryRecords?: MCPServerRegistryRecord[];
}

export interface ToolExecutionPolicy {
  maxRiskLevel?: ToolRiskLevel;
  allowWrites?: boolean;
  sandboxAvailable?: boolean;
  retry?: Partial<ToolRetryPolicy>;
}

export interface ToolRetryPolicy {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

export type ToolExecutionDecision =
  | {
      allowed: true;
      capability: ToolCapability;
      policy: ToolExecutionPolicy;
    }
  | {
      allowed: false;
      reasonCode: ToolExecutionReasonCode;
      reason: string;
      capability?: ToolCapability;
      policy: ToolExecutionPolicy;
    };

export interface ToolRegistry {
  register(name: string, handler: ToolHandler, def: ToolDef, capability?: Partial<ToolCapability>): void;
  execute(input: ToolInput): Promise<ToolResult>;
  evaluateTool(name: string): ToolExecutionDecision;
  getDefinitions(): ToolDef[];
  getCapabilities(): ToolCapability[];
  getCapability(name: string): ToolCapability | null;
  list(): string[];
}

// ── Registry ─────────────────────────────────────────────

export const READ_ONLY_BUILTIN_TOOLS = [
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

function normalizeCapability(name: string, capability: Partial<ToolCapability> = {}): ToolCapability {
  const riskLevel = capability.riskLevel ?? 'L1';
  return {
    name,
    inputSchema: capability.inputSchema,
    outputSchema: capability.outputSchema,
    permissions: capability.permissions ?? [],
    riskLevel,
    timeoutMs: capability.timeoutMs ?? defaultTimeoutForRisk(riskLevel),
    retryable: capability.retryable ?? false,
    idempotent: capability.idempotent ?? false,
    costLevel: capability.costLevel ?? 'low',
    sideEffect: capability.sideEffect ?? false,
    sandboxRequired: capability.sandboxRequired ?? false,
    needsApproval: capability.needsApproval ?? riskLevel === 'L2',
    tags: capability.tags ?? [],
  };
}

function defaultTimeoutForRisk(riskLevel: ToolRiskLevel): number {
  if (riskLevel === 'L0') return 30_000;
  if (riskLevel === 'L1') return 60_000;
  return 300_000;
}

function checkCapability(
  capability: ToolCapability | undefined,
  policy: ToolExecutionPolicy,
): { allowed: true; capability: ToolCapability } | { allowed: false; reasonCode: ToolExecutionReasonCode; reason: string } {
  if (!capability) {
    return { allowed: false, reasonCode: 'tool_capability_missing', reason: 'Tool capability missing' };
  }

  const maxRiskLevel = policy.maxRiskLevel ?? 'L2';
  if (riskRank(capability.riskLevel) > riskRank(maxRiskLevel)) {
    return {
      allowed: false,
      reasonCode: 'tool_risk_exceeded',
      reason: `Tool risk ${capability.riskLevel} exceeds max ${maxRiskLevel}: ${capability.name}`,
    };
  }

  if (capability.riskLevel === 'L1' && policy.allowWrites === false) {
    return {
      allowed: false,
      reasonCode: 'tool_writes_disabled',
      reason: `Writes disabled: ${capability.name}`,
    };
  }

  if (capability.sandboxRequired && policy.sandboxAvailable === false) {
    return {
      allowed: false,
      reasonCode: 'tool_sandbox_required',
      reason: `Sandbox required: ${capability.name}`,
    };
  }

  return { allowed: true, capability };
}

function riskRank(riskLevel: ToolRiskLevel): number {
  if (riskLevel === 'L0') return 0;
  if (riskLevel === 'L1') return 1;
  return 2;
}

async function executeWithRetry(
  input: ToolInput,
  handler: ToolHandler,
  capability: ToolCapability,
  policy: ToolExecutionPolicy,
): Promise<ToolResult> {
  const retryPolicy = normalizeRetryPolicy(policy.retry);
  const maxAttempts = capability.retryable && capability.idempotent ? retryPolicy.maxAttempts : 1;
  const retryErrors: string[] = [];
  let lastResult: ToolResult = { content: '', error: `Tool failed: ${input.name}` };

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const result = await withTimeout(handler(input.arguments), capability.timeoutMs, input.name);
      lastResult = result.error
        ? { ...result }
        : { ...result, attempts: attempt, retried: attempt > 1, retryErrors };

      if (!result.error) {
        return lastResult;
      }
      retryErrors.push(result.error);
    } catch (err: any) {
      const message = err?.message ?? String(err);
      retryErrors.push(message);
      lastResult = { content: '', error: message };
    }

    if (attempt < maxAttempts) {
      await delay(computeRetryDelayMs(retryPolicy, attempt));
    }
  }

  return {
    ...lastResult,
    attempts: maxAttempts,
    retried: maxAttempts > 1,
    retryErrors,
  };
}

function normalizeRetryPolicy(input: Partial<ToolRetryPolicy> | undefined): ToolRetryPolicy {
  const maxAttempts = Number.isFinite(input?.maxAttempts)
    ? Math.max(1, Math.min(5, Math.floor(input!.maxAttempts!)))
    : 1;
  const baseDelayMs = Number.isFinite(input?.baseDelayMs)
    ? Math.max(0, Math.min(60_000, Math.floor(input!.baseDelayMs!)))
    : 100;
  const maxDelayMs = Number.isFinite(input?.maxDelayMs)
    ? Math.max(baseDelayMs, Math.min(120_000, Math.floor(input!.maxDelayMs!)))
    : 2_000;

  return {
    maxAttempts,
    baseDelayMs,
    maxDelayMs,
  };
}

function computeRetryDelayMs(policy: ToolRetryPolicy, completedAttempt: number): number {
  const delay = policy.baseDelayMs * 2 ** Math.max(0, completedAttempt - 1);
  return Math.min(delay, policy.maxDelayMs);
}

function delay(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise(resolve => setTimeout(resolve, ms));
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, toolName: string): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return promise;

  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`Tool timed out after ${timeoutMs}ms: ${toolName}`));
    }, timeoutMs);
    promise.then(
      value => {
        clearTimeout(timeout);
        resolve(value);
      },
      err => {
        clearTimeout(timeout);
        reject(err);
      },
    );
  });
}
