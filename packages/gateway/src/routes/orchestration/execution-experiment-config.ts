import type { ExecutionExperimentConfigDiff, RunSpecRecord } from '@los/agent';
import { getPiK4KernelSelectionIdentity } from '@los/agent';
import { asRecord, normalizeOptionalString } from '../server-helpers.js';

const ALLOWED_DIFF_PATHS = new Set([
  'provider',
  'model',
  'toolMode',
  'allowedTools',
  'maxLoops',
  'timeoutMs',
  'modelSettings',
  'executionKernel',
]);
const ALLOWED_TOOL_MODES = new Set(['all', 'project-write', 'read-only']);

export function parseExecutionExperimentConfigDiff(value: unknown): ExecutionExperimentConfigDiff[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => {
    const row = asRecord(item);
    const path = normalizeOptionalString(row.path);
    if (!path || !ALLOWED_DIFF_PATHS.has(path)) throw new Error(`configDiff path is not allowed: ${String(row.path)}`);
    validateDiffValue(path, row.value);
    return { path, value: row.value, inherited: row.inherited === true };
  });
}

export function readK4KernelCandidate(
  diff: ExecutionExperimentConfigDiff[],
): { disposition: 'planning' | 'inspection' } | undefined {
  const entries = diff.filter(item => item.path === 'executionKernel');
  if (entries.length === 0) return undefined;
  if (entries.length !== 1) throw new Error('configDiff must contain exactly one executionKernel candidate');
  const value = asRecord(entries[0]!.value);
  const disposition = value.disposition === 'planning' || value.disposition === 'inspection'
    ? value.disposition
    : undefined;
  const candidateIdentity = getPiK4KernelSelectionIdentity();
  if (value.kind !== candidateIdentity.kind
    || value.version !== candidateIdentity.version
    || value.protocolVersion !== candidateIdentity.protocolVersion
    || !disposition) {
    throw new Error('executionKernel must select exact pi@0.81.1+los.3 protocol 0.1.0 for planning or inspection');
  }
  const toolMode = diff.find(item => item.path === 'toolMode');
  if (toolMode && toolMode.value !== 'read-only') throw new Error('Pi K4 executionKernel requires configDiff toolMode=read-only');
  return { disposition };
}

export function applyExecutionExperimentDiff(source: RunSpecRecord, diff: ExecutionExperimentConfigDiff[]) {
  const result = {
    provider: source.provider,
    model: source.model,
    modelSettings: { ...source.modelSettings },
    workspaceRoot: source.workspaceRoot,
    toolMode: source.toolMode,
    allowedTools: [...source.allowedTools],
    toolRetry: { ...source.toolRetry },
    maxLoops: source.maxLoops,
    timeoutMs: source.timeoutMs,
    mcpServers: source.mcpServers,
  };
  for (const item of diff) {
    if (item.path === 'modelSettings') result.modelSettings = asRecord(item.value);
    else if (item.path === 'allowedTools' && Array.isArray(item.value)) result.allowedTools = item.value.filter((value): value is string => typeof value === 'string');
    else if (item.path === 'provider' || item.path === 'model' || item.path === 'toolMode') (result as any)[item.path] = String(item.value);
    else if (item.path === 'maxLoops' || item.path === 'timeoutMs') (result as any)[item.path] = Number(item.value);
  }
  return result;
}

function validateDiffValue(path: string, value: unknown): void {
  if (path === 'maxLoops' || path === 'timeoutMs') {
    if (!Number.isSafeInteger(value) || Number(value) <= 0) throw new Error(`configDiff ${path} must be a positive integer`);
  }
  if (path === 'provider' || path === 'model') {
    if (typeof value !== 'string' || value.trim().length === 0) throw new Error(`configDiff ${path} must be a non-empty string`);
  }
  if (path === 'toolMode' && (typeof value !== 'string' || !ALLOWED_TOOL_MODES.has(value))) {
    throw new Error('configDiff toolMode must be all, project-write, or read-only');
  }
  if (path === 'allowedTools' && (!Array.isArray(value) || value.some(tool => typeof tool !== 'string' || tool.trim().length === 0))) {
    throw new Error('configDiff allowedTools must be an array of non-empty strings');
  }
  if (path === 'modelSettings' && (value === null || typeof value !== 'object' || Array.isArray(value))) {
    throw new Error('configDiff modelSettings must be an object');
  }
  if (path === 'executionKernel') readK4KernelCandidate([{ path, value }]);
}
