import { listExecutorNodes, sortExecutorCandidates, type ExecutorNodeRecord } from '../executor-nodes.js';
import type { AgentConfig, AgentResult, ToolCallStateTransition } from '../loop.js';
import type { KernelEvent } from '../execution-kernel.js';
import { normalizeOptionalString, readObject, readString } from './helpers.js';
import type {
  ExecutorCapabilityRequirement,
  ExecutorPlacementIntent,
  ScheduledExecutorConfig,
} from './types.js';
import { resolveSSHExecutorNodeUrl, resolveSSHExecutor, runAgentOnSSHExecutor, sshExecutorUrlToConnectConfig } from './ssh-client.js';

export type ResolvedExecutor = {
  url: string;
  nodeId: string;
  agentKey?: string;
  decision: ExecutorSelectionDecision;
};

export type ExecutorSelectionDecision = {
  source: 'config_node_url' | 'executor_registry';
  placementTier?: 'warm' | 'clone' | 'cold' | 'degraded';
  requiredCapabilities: ExecutorCapabilityRequirement[];
  candidateIds: string[];
  selectedId?: string;
  skipped: Array<{ id: string; reason: string; details?: Record<string, unknown> }>;
};

export class _ExecutorSelectionError extends Error {
  constructor(message: string, readonly decision: ExecutorSelectionDecision) {
    super(message);
    this.name = 'ExecutorSelectionError';
  }
}

export async function resolveExecutor(
  config: ScheduledExecutorConfig | undefined,
  intent: ExecutorPlacementIntent = {},
): Promise<ResolvedExecutor | null> {
  if (!config?.enabled) return null;
  const requiredCapabilities = _compileExecutorRequirements(config, intent);

  if (config.nodeUrls && config.nodeUrls.length > 0) {
    const normalizedUrls = config.nodeUrls.map(normalizeExecutorUrl);
    const firstUrl = normalizedUrls.find(Boolean);
    if (!firstUrl) {
      throw new Error('Executor is enabled but no executor node URL is configured');
    }
    const nodeId = normalizeOptionalString(config.nodeId) ?? firstUrl;
    return {
      url: firstUrl,
      nodeId,
      agentKey: normalizeOptionalString(config.agentKey),
      decision: {
        source: 'config_node_url',
        placementTier: 'degraded',
        requiredCapabilities,
        candidateIds: normalizedUrls.filter(Boolean),
        selectedId: nodeId,
        skipped: normalizedUrls
          .map((url, index) => ({ url, index }))
          .filter(item => !item.url)
          .map(item => ({ id: `nodeUrls[${item.index}]`, reason: 'invalid_executor_url' })),
      },
    };
  }

  const nodes = await listExecutorNodes(100);
  const candidates = nodes.filter(node => node.execution.candidate);
  const preferredNodeId = normalizeOptionalString(config.nodeId);
  const ordered = sortExecutorCandidates(candidates, preferredNodeId);

  const skipped: ExecutorSelectionDecision['skipped'] = nodes
    .filter(node => node.nodeKind === 'executor' && !node.execution.candidate)
    .map(node => ({
      id: node.nodeId,
      reason: node.execution.blockers[0] ?? 'not_candidate',
      details: { blockers: node.execution.blockers, warnings: node.execution.warnings },
    }));
  for (const node of ordered) {
    const url = resolveExecutorNodeUrl(node);
    if (!url) {
      skipped.push({ id: node.nodeId, reason: 'missing_agent_http_url' });
      continue;
    }
    const resourceIntensive = requiredCapabilities.includes('heavy_task_safe')
      || requiredCapabilities.includes('deploy_safe');
    if (resourceIntensive && node.execution.warnings.includes('resource:memory_pressure')) {
      skipped.push({
        id: node.nodeId,
        reason: 'resource:memory_pressure',
        details: { requiredCapabilities },
      });
      continue;
    }
    const missingCapabilities = requiredCapabilities.filter(requirement => !satisfiesCapability(node, requirement));
    if (missingCapabilities.length > 0) {
      skipped.push({
        id: node.nodeId,
        reason: `capability:${missingCapabilities[0]}_missing`,
        details: { missingCapabilities },
      });
      continue;
    }
    return {
      url,
      nodeId: node.nodeId,
      agentKey: normalizeOptionalString(config.agentKey),
      decision: {
        source: 'executor_registry',
        placementTier: 'warm',
        requiredCapabilities,
        candidateIds: ordered.map(item => item.nodeId),
        selectedId: node.nodeId,
        skipped,
      },
    };
  }

  const decision: ExecutorSelectionDecision = {
    source: 'executor_registry',
    requiredCapabilities,
    candidateIds: ordered.map(item => item.nodeId),
    skipped,
  };
  if (candidates.length > 0) {
    throw new _ExecutorSelectionError(
      `Executor is enabled but no candidate executor node passes capability gates: ${skipped.map(s => `${s.id}:${s.reason}`).join(', ')}`,
      decision,
    );
  }
  throw new _ExecutorSelectionError(
    'Executor is enabled but no verified executor node candidate is available',
    decision,
  );
}

export function _compileExecutorRequirements(
  config: ScheduledExecutorConfig,
  intent: ExecutorPlacementIntent = {},
): ExecutorCapabilityRequirement[] {
  const requirements = new Set<ExecutorCapabilityRequirement>(config.requiredCapabilities ?? []);
  const sandboxMode = intent.sandboxMode;
  const toolMode = intent.toolMode ?? 'project-write';

  if (sandboxMode === 'readonly' || (!sandboxMode && toolMode === 'read-only')) {
    requirements.add('workspace_read');
  } else {
    requirements.add('workspace_write');
  }
  if (sandboxMode === 'sandbox') {
    requirements.add('shell');
    requirements.add('sandbox');
  } else if (!sandboxMode && toolMode === 'all') {
    requirements.add('shell');
  }
  if (config.requiresBuild) requirements.add('heavy_task_safe');
  if (config.requiresDeploy) requirements.add('deploy_safe');

  return [...requirements].sort();
}

function satisfiesCapability(node: ExecutorNodeRecord, requirement: ExecutorCapabilityRequirement): boolean {
  const value = node.capabilities[requirement];
  if (requirement !== 'sandbox') return value === true;
  if (value === true) return true;
  if (typeof value !== 'string') return false;
  return value !== 'native' && value !== 'none' && value !== 'tool_policy';
}

export async function runAgentOnExecutor(
  executor: ResolvedExecutor,
  input: {
    taskRunId: string;
    leaseVersion: number;
    agentTaskLease?: { taskId: string; leaseVersion: number };
    leaseMs: number;
    executionKernelKind: string;
    prompt: string;
    config: Omit<AgentConfig, 'signal' | 'onSessionEvent' | 'onProviderFallback' | 'onTurn' | 'onToolCall' | 'onCheckpoint'>;
    signal?: AbortSignal;
    onSessionEvent?: AgentConfig['onSessionEvent'];
    onModelDelta?: AgentConfig['onModelDelta'];
    onToolCallState?: AgentConfig['onToolCallState'];
    onCheckpoint?: AgentConfig['onCheckpoint'];
    onKernelEvent?: (event: KernelEvent) => void | Promise<void>;
  },
): Promise<AgentResult> {
  // SSH-backed executors use a different transport (ssh CLI + ndjson stream).
  if (executor.url.startsWith('ssh://')) {
    const sshExecutor = resolveSSHExecutor({
      nodeId: executor.nodeId,
      nodeKind: 'ssh_target',
      connectModes: ['direct_ssh'],
      connectConfig: sshExecutorUrlToConnectConfig(executor.url),
    } as ExecutorNodeRecord);
    if (!sshExecutor) throw new Error(`SSH executor URL ${executor.url} missing valid SSH config`);
    return await runAgentOnSSHExecutor(sshExecutor, input);
  }

  const res = await fetch(`${executor.url}/v1/tasks/run-agent`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/x-ndjson, application/json',
      ...(executor.agentKey ? { 'Authorization': `Bearer ${executor.agentKey}` } : {}),
    },
    body: JSON.stringify({
      taskRunId: input.taskRunId,
      nodeId: executor.nodeId,
      leaseVersion: input.leaseVersion,
      agentTaskLease: input.agentTaskLease,
      leaseMs: input.leaseMs,
      executionKernelKind: input.executionKernelKind,
      prompt: input.prompt,
      config: input.config,
    }),
    signal: input.signal,
  });

  if (res.headers.get('content-type')?.includes('application/x-ndjson')) {
    return await readExecutorStreamResponse(res, executor, input);
  }

  const data = await readJsonResponse(res);
  if (!res.ok) {
    const message = typeof data?.error === 'string' ? data.error : `Executor ${executor.url} failed with ${res.status}`;
    throw new Error(message);
  }

  const events = Array.isArray(data?.events) ? data.events : [];
  for (const event of events) {
    await input.onSessionEvent?.(event);
  }
  const deltas = Array.isArray(data?.deltas) ? data.deltas : [];
  for (const delta of deltas) {
    await input.onModelDelta?.(delta);
  }
  const toolCallStates = Array.isArray(data?.toolCallStates) ? data.toolCallStates : [];
  for (const transition of toolCallStates) {
    await input.onToolCallState?.(transition as ToolCallStateTransition);
  }
  const kernelEvents = Array.isArray(data?.kernelEvents) ? data.kernelEvents : [];
  for (const event of kernelEvents) await input.onKernelEvent?.(event as KernelEvent);
  if (!data?.result || typeof data.result !== 'object') {
    throw new Error(`Executor ${executor.url} returned no agent result`);
  }
  return data.result as AgentResult;
}

function resolveExecutorNodeUrl(node: ExecutorNodeRecord): string | null {
  const mode = node.execution.mode;
  const modeConfig = readObject(mode ? node.connectConfig[mode] : undefined);
  const agentHttpConfig = readObject(node.connectConfig.agent_http);
  const agentNdjsonConfig = readObject(node.connectConfig.agent_http_ndjson);

  // Prefer SSH-based modes when the node is an ssh_target or has SSH config.
  const sshUrl = resolveSSHExecutorNodeUrl(node);
  if (sshUrl) return sshUrl;

  const raw =
    readString(modeConfig.baseUrl) ??
    readString(modeConfig.endpoint) ??
    readString(agentHttpConfig.baseUrl) ??
    readString(agentHttpConfig.endpoint) ??
    readString(agentNdjsonConfig.baseUrl) ??
    readString(agentNdjsonConfig.endpoint) ??
    node.baseUrl;
  return raw ? normalizeExecutorUrl(stripExecutorEndpointPath(raw)) : null;
}

function stripExecutorEndpointPath(value: string): string {
  const trimmed = value.trim();
  if (!/^https?:\/\//i.test(trimmed)) return trimmed;
  try {
    const url = new URL(trimmed);
    if (url.pathname === '/health') {
      url.pathname = '';
    } else if (url.pathname === '/v1/tasks/run-agent') {
      url.pathname = '';
    }
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return trimmed;
  }
}

function normalizeExecutorUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return '';
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  return withScheme.replace(/\/+$/, '');
}

async function readExecutorStreamResponse(
  res: Response,
  executor: ResolvedExecutor,
  input: {
    onSessionEvent?: AgentConfig['onSessionEvent'];
    onModelDelta?: AgentConfig['onModelDelta'];
    onToolCallState?: AgentConfig['onToolCallState'];
    onKernelEvent?: (event: KernelEvent) => void | Promise<void>;
  },
): Promise<AgentResult> {
  if (!res.ok) {
    const error = await readJsonResponse(res);
    const message = typeof error?.error === 'string' ? error.error : `Executor ${executor.url} failed with ${res.status}`;
    throw new Error(message);
  }

  const reader = res.body?.getReader();
  if (!reader) throw new Error(`Executor ${executor.url} returned no stream body`);

  const decoder = new TextDecoder();
  let buffer = '';
  let result: AgentResult | null = null;

  const processLine = async (line: string) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    const chunk = JSON.parse(trimmed) as {
      type?: string;
      event?: unknown;
      delta?: unknown;
      transition?: unknown;
      kernelEvent?: unknown;
      result?: unknown;
      error?: string;
    };
    if (chunk.type === 'session_event') {
      await input.onSessionEvent?.(chunk.event as any);
    } else if (chunk.type === 'model_delta') {
      await input.onModelDelta?.(chunk.delta as any);
    } else if (chunk.type === 'tool_call_state') {
      await input.onToolCallState?.(chunk.transition as ToolCallStateTransition);
    } else if (chunk.type === 'kernel_event') {
      await input.onKernelEvent?.(chunk.kernelEvent as KernelEvent);
    } else if (chunk.type === 'result') {
      result = chunk.result as AgentResult;
    } else if (chunk.type === 'error') {
      throw new Error(chunk.error ?? `Executor ${executor.url} stream failed`);
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (value) {
      buffer += decoder.decode(value, { stream: !done });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        await processLine(line);
      }
    }
    if (done) break;
  }
  await processLine(buffer);

  if (!result) throw new Error(`Executor ${executor.url} stream completed without an agent result`);
  return result;
}

async function readJsonResponse(res: Response): Promise<any> {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { error: text.slice(0, 500) };
  }
}
