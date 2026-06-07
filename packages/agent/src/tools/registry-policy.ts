import type { ToolDef } from '../providers/index.js';
import type { MCPServerConfig, MCPServerRegistryRecord } from './mcp-client.js';

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

export function normalizeCapability(name: string, capability: Partial<ToolCapability> = {}): ToolCapability {
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

export function checkCapability(
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

export async function executeWithRetry(
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

function defaultTimeoutForRisk(riskLevel: ToolRiskLevel): number {
  if (riskLevel === 'L0') return 30_000;
  if (riskLevel === 'L1') return 60_000;
  return 300_000;
}

function riskRank(riskLevel: ToolRiskLevel): number {
  if (riskLevel === 'L0') return 0;
  if (riskLevel === 'L1') return 1;
  return 2;
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
