import type { AgentTaskRecord } from '../agent-task-graph.js';
import {
  listLatestProviderCompatEvidence,
  type ProviderCompatEvidenceRecord,
} from '../provider-compat-evidence.js';
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

  if (targets.length > 0) {
    const evidence = await listLatestProviderCompatEvidence();
    const selected = selectProviderModelTargetFromEvidence(targets, evidence);
    if (selected) {
      return {
        provider: selected.target.provider,
        model: selected.target.model ?? selected.evidence.model,
        source: 'provider_compat_evidence',
        evidenceId: selected.evidence.id,
        targetLabel: targetLabel(selected.target),
        requireProviderCompat,
        rejectedTargetLabels: targets
          .filter(target => targetLabel(target) !== targetLabel(selected.target))
          .map(targetLabel),
      };
    }
    if (requireProviderCompat) {
      throw new Error(`graph task ${task.id} requires passing provider compatibility evidence for targets: ${targets.map(targetLabel).join(', ')}`);
    }
    const fallback = targets[0];
    return {
      provider: fallback?.provider,
      model: fallback?.model,
      source: 'graph_task_target',
      targetLabel: fallback ? targetLabel(fallback) : undefined,
      requireProviderCompat,
      rejectedTargetLabels: targets.slice(1).map(targetLabel),
    };
  }

  const explicit = readProviderModelTarget(task.metadata) ?? readProviderModelTarget(runContract);
  if (explicit?.provider) {
    return {
      provider: explicit.provider,
      model: explicit.model,
      source: 'task_metadata',
      targetLabel: targetLabel(explicit),
      requireProviderCompat,
    };
  }

  return {
    provider: input.provider,
    model: input.model,
    source: 'scheduler_input',
    targetLabel: targetLabel({ provider: input.provider, model: input.model }),
    requireProviderCompat,
  };
}

function selectProviderModelTargetFromEvidence(
  targets: readonly GraphTaskRequiredProviderModelTarget[],
  evidence: readonly ProviderCompatEvidenceRecord[],
): { target: GraphTaskRequiredProviderModelTarget; evidence: ProviderCompatEvidenceRecord } | undefined {
  for (const target of targets) {
    const passed = evidence.find(item => (
      item.passed
      && item.provider === target.provider
      && (!target.model || item.model === target.model)
    ));
    if (passed) return { target, evidence: passed };
  }
  return undefined;
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

function targetLabel(target: GraphTaskProviderModelTarget): string {
  if (!target.provider) return target.model ? `?:${target.model}` : 'scheduler-default';
  return target.model ? `${target.provider}:${target.model}` : target.provider;
}
