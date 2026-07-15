import type { AgentTaskRecord } from '../agent-task-graph.js';
import {
  listLatestProviderCompatEvidence,
} from '../provider-compat-evidence.js';
import { resolveProviderModelPolicy } from '../providers/provider-policy.js';
import { normalizeOptionalString, readBoolean, readObject } from './helpers.js';
import type {
  GraphTaskProviderModelSelection,
  GraphTaskProviderModelTarget,
  GraphTaskRequiredProviderModelTarget,
  RunAgentTaskGraphSerialInput,
} from './types.js';

export async function resolveGraphTaskProviderModelSelection(
  task: AgentTaskRecord,
  input: RunAgentTaskGraphSerialInput,
): Promise<GraphTaskProviderModelSelection> {
  const runContract = readObject(task.metadata.runContract);
  const targets = readProviderModelTargets(task.metadata.providerModelTargets ?? runContract.providerModelTargets);
  const requireProviderCompat = readBoolean(task.metadata.requireProviderCompat)
    ?? readBoolean(runContract.requireProviderCompat)
    ?? false;
  const explicit = readProviderModelTarget(task.metadata) ?? readProviderModelTarget(runContract);
  const evidence = targets.length > 0 ? await listLatestProviderCompatEvidence() : [];
  return resolveProviderModelPolicy({
    targets,
    evidence,
    requireProviderCompat,
    explicit: explicit?.provider ? explicit : undefined,
    fallback: { provider: input.provider, model: input.model },
    emptyTargetLabel: 'scheduler-default',
    contextLabel: `graph task ${task.id}`,
    sources: {
      evidence: 'provider_compat_evidence',
      target: 'graph_task_target',
      explicit: 'task_metadata',
      fallback: 'scheduler_input',
    },
  });
}

function readProviderModelTargets(value: unknown): GraphTaskRequiredProviderModelTarget[] {
  if (!Array.isArray(value)) return [];
  return value
    .map(readProviderModelTarget)
    .filter((target): target is GraphTaskRequiredProviderModelTarget => Boolean(target?.provider));
}

function readProviderModelTarget(value: unknown): GraphTaskProviderModelTarget | undefined {
  if (typeof value === 'string') {
    const [provider, ...modelParts] = value.split(':');
    const normalizedProvider = normalizeOptionalString(provider);
    if (!normalizedProvider) return undefined;
    return {
      provider: normalizedProvider,
      model: normalizeOptionalString(modelParts.join(':')),
    };
  }
  const record = readObject(value);
  const provider = normalizeOptionalString(record.provider);
  const model = normalizeOptionalString(record.model);
  if (!provider && !model) return undefined;
  return { provider, model };
}
