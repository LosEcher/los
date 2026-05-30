export type CompatibilityToolMode = 'read-only' | 'project-write';

export interface ProviderModelTarget {
  provider: string;
  model?: string;
  label: string;
}

export interface CompatibilityProbe {
  id: string;
  title: string;
  prompt: string;
  toolMode: CompatibilityToolMode;
  maxLoops: number;
  expectedTools: string[];
  writesWorkspace: boolean;
}

export interface CompatibilityRunSpec {
  id: string;
  target: ProviderModelTarget;
  probe: CompatibilityProbe;
  request: {
    prompt: string;
    provider: string;
    model?: string;
    toolMode: CompatibilityToolMode;
    maxLoops: number;
    workspaceRoot?: string;
    traceId?: string;
    dedupeKey?: string;
  };
}

export interface CompatibilityHarnessOptions {
  targets?: ProviderModelTarget[];
  probes?: CompatibilityProbe[];
  workspaceRoot?: string;
  tracePrefix?: string;
  dedupePrefix?: string;
  maxLoops?: number;
}

export interface CompatibilitySseEvent {
  event: string;
  data: Record<string, unknown>;
}

export interface CompatibilityRunSummary {
  specId: string;
  provider: string;
  model?: string;
  probeId: string;
  sessionId?: string;
  taskRunId?: string;
  effectiveModel?: string;
  protocol?: string;
  reasoningSupported?: boolean;
  reasoningObserved: boolean;
  toolCalls: string[];
  toolResultCount: number;
  failedToolResultCount: number;
  deniedToolCount: number;
  totalTokens: number;
  completed: boolean;
  cancelled: boolean;
  error?: string;
}

export const DEFAULT_COMPATIBILITY_TARGETS: ProviderModelTarget[] = [
  target('deepseek', 'deepseek-v4-flash'),
  target('deepseek', 'deepseek-v4-pro'),
  target('codex', 'gpt-5.5'),
  target('codex', 'gpt-5.4'),
];

export const DEFAULT_COMPATIBILITY_PROBES: CompatibilityProbe[] = [
  {
    id: 'read-context',
    title: 'Read workspace context',
    toolMode: 'read-only',
    maxLoops: 4,
    expectedTools: ['list_directory', 'read_file'],
    writesWorkspace: false,
    prompt: [
      'Inspect the current workspace as a coding agent compatibility probe.',
      'Use list_directory on "." and read_file on "package.json".',
      'Return the project name, package manager, and available top-level scripts.',
    ].join('\n'),
  },
  {
    id: 'patch-preview',
    title: 'Preview deterministic patch',
    toolMode: 'project-write',
    maxLoops: 5,
    expectedTools: ['read_file', 'preview_patch'],
    writesWorkspace: false,
    prompt: [
      'Run a non-writing edit compatibility probe.',
      'Read "README.md", then use preview_patch to preview replacing the first heading "# los" with "# los".',
      'Do not use write_file, apply_patch, edit_file, or run_shell.',
      'Summarize whether the preview tool was accepted.',
    ].join('\n'),
  },
];

export function target(provider: string, model?: string): ProviderModelTarget {
  return {
    provider,
    model,
    label: model ? `${provider}:${model}` : provider,
  };
}

export function parseCompatibilityTarget(raw: string): ProviderModelTarget {
  const trimmed = raw.trim();
  if (!trimmed) throw new Error('target must not be empty');
  const [provider, ...modelParts] = trimmed.split(':');
  const model = modelParts.join(':').trim();
  return target(provider.trim(), model || undefined);
}

export function parseCompatibilityTargets(rawTargets: readonly string[] | undefined): ProviderModelTarget[] {
  const values = rawTargets?.map(value => value.trim()).filter(Boolean) ?? [];
  if (values.length === 0) return DEFAULT_COMPATIBILITY_TARGETS;
  return values.map(parseCompatibilityTarget);
}

export function selectCompatibilityProbes(ids: readonly string[] | undefined): CompatibilityProbe[] {
  const selected = ids?.map(id => id.trim()).filter(Boolean) ?? [];
  if (selected.length === 0) return DEFAULT_COMPATIBILITY_PROBES;

  const probes = new Map(DEFAULT_COMPATIBILITY_PROBES.map(probe => [probe.id, probe]));
  return selected.map(id => {
    const probe = probes.get(id);
    if (!probe) {
      throw new Error(`Unknown compatibility probe: ${id}`);
    }
    return probe;
  });
}

export function createCompatibilityRunSpecs(options: CompatibilityHarnessOptions = {}): CompatibilityRunSpec[] {
  const targets = options.targets?.length ? options.targets : DEFAULT_COMPATIBILITY_TARGETS;
  const probes = options.probes?.length ? options.probes : DEFAULT_COMPATIBILITY_PROBES;
  const specs: CompatibilityRunSpec[] = [];

  for (const target of targets) {
    for (const probe of probes) {
      const id = `${target.label}/${probe.id}`;
      const maxLoops = options.maxLoops ?? probe.maxLoops;
      specs.push({
        id,
        target,
        probe,
        request: {
          prompt: probe.prompt,
          provider: target.provider,
          model: target.model,
          toolMode: probe.toolMode,
          maxLoops,
          workspaceRoot: options.workspaceRoot,
          traceId: options.tracePrefix ? `${options.tracePrefix}:${id}` : undefined,
          dedupeKey: options.dedupePrefix ? `${options.dedupePrefix}:${id}` : undefined,
        },
      });
    }
  }

  return specs;
}

export function summarizeCompatibilityEvents(
  spec: CompatibilityRunSpec,
  events: readonly CompatibilitySseEvent[],
): CompatibilityRunSummary {
  const toolCalls: string[] = [];
  let sessionId: string | undefined;
  let taskRunId: string | undefined;
  let effectiveModel: string | undefined;
  let protocol: string | undefined;
  let reasoningSupported: boolean | undefined;
  let reasoningObserved = false;
  let toolResultCount = 0;
  let failedToolResultCount = 0;
  let deniedToolCount = 0;
  let totalTokens = 0;
  let completed = false;
  let cancelled = false;
  let error: string | undefined;

  for (const item of events) {
    const data = item.data;
    const payload = asRecord(data.payload);
    if (typeof data.sessionId === 'string') sessionId = data.sessionId;
    if (typeof data.taskRunId === 'string') taskRunId = data.taskRunId;

    if (item.event === 'session.started') {
      if (typeof payload.effectiveModel === 'string') effectiveModel = payload.effectiveModel;
      const modelProfile = asRecord(payload.modelProfile);
      if (typeof modelProfile.protocol === 'string') protocol = modelProfile.protocol;
      if (typeof modelProfile.supportsReasoning === 'boolean') reasoningSupported = modelProfile.supportsReasoning;
    }

    if (item.event === 'model.response') {
      const usage = asRecord(data.usage);
      totalTokens += numberValue(usage.totalTokens);
      if (numberValue(payload.reasoningLength) > 0) reasoningObserved = true;
    }

    if (item.event === 'tool.call') {
      const toolName = typeof data.toolName === 'string' ? data.toolName : undefined;
      if (toolName) toolCalls.push(toolName);
    }

    if (item.event === 'tool.result') {
      toolResultCount += 1;
      if (payload.ok === false) failedToolResultCount += 1;
    }

    if (item.event === 'tool.denied') {
      deniedToolCount += 1;
    }

    if (item.event === 'done' || item.event === 'session.completed') completed = true;
    if (item.event === 'cancelled') cancelled = true;
    if (item.event === 'error') error = typeof data.message === 'string' ? data.message : JSON.stringify(data);
  }

  return {
    specId: spec.id,
    provider: spec.target.provider,
    model: spec.target.model,
    probeId: spec.probe.id,
    sessionId,
    taskRunId,
    effectiveModel,
    protocol,
    reasoningSupported,
    reasoningObserved,
    toolCalls,
    toolResultCount,
    failedToolResultCount,
    deniedToolCount,
    totalTokens,
    completed,
    cancelled,
    error,
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function numberValue(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}
