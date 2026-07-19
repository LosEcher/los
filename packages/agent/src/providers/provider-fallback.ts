import { AgentError } from '../error-base.js';
import type { Provider, CreateProviderOptions, Message, ToolDef, ChatOptions, ProviderResponse } from './types.js';

export type ProviderFallbackFailureClass = 'transport' | 'rate_limit' | 'provider_unavailable';

export interface ProviderFallbackTarget {
  provider: string;
  model?: string;
}

export interface ProviderFallbackPolicy {
  mode: 'explicit_ordered';
  targets: ProviderFallbackTarget[];
  onFailure: ProviderFallbackFailureClass[];
  requireCompatibilityEvidence: boolean;
  maxSwitches: number;
}

export interface ProviderFallbackEvidence {
  id: string;
  provider: string;
  model?: string;
  passed: boolean;
}

export interface PreparedProviderFallbackTarget extends ProviderFallbackTarget {
  compatibilityEvidenceId?: string;
}

export interface ProviderFallbackEvent {
  type: 'selected' | 'exhausted';
  callIndex: number;
  switchIndex: number;
  failureClass: ProviderFallbackFailureClass;
  errorCode?: string;
  errorMessage: string;
  fromProvider: string;
  fromModel: string;
  toProvider?: string;
  toModel?: string;
  compatibilityEvidenceId?: string;
}

export function normalizeProviderFallbackPolicy(value: unknown): ProviderFallbackPolicy | undefined {
  if (value === undefined || value === null) return undefined;
  const input = asRecord(value);
  if (input.mode !== 'explicit_ordered') {
    throw new Error('providerFallback.mode must be explicit_ordered');
  }
  if (!Array.isArray(input.targets) || input.targets.length < 2 || input.targets.length > 5) {
    throw new Error('providerFallback.targets must contain 2 to 5 ordered targets');
  }
  const targets = input.targets.map((target, index) => normalizeTarget(target, index));
  const labels = targets.map(formatTarget);
  if (new Set(labels).size !== labels.length) {
    throw new Error('providerFallback.targets must not contain duplicates');
  }
  const onFailure = normalizeFailureClasses(input.onFailure);
  const requireCompatibilityEvidence = input.requireCompatibilityEvidence !== false;
  const requestedMaxSwitches = normalizeInteger(input.maxSwitches) ?? targets.length - 1;
  const maxSwitches = Math.min(requestedMaxSwitches, targets.length - 1, 4);
  if (maxSwitches < 1) throw new Error('providerFallback.maxSwitches must be at least 1');
  return {
    mode: 'explicit_ordered',
    targets,
    onFailure,
    requireCompatibilityEvidence,
    maxSwitches,
  };
}

export function resolveProviderFallbackInitialTarget(
  value: unknown,
  requested: { provider?: string; model?: string } = {},
): ProviderFallbackTarget | undefined {
  const policy = normalizeProviderFallbackPolicy(value);
  if (!policy) return undefined;
  const first = policy.targets[0]!;
  const requestedProvider = normalizeString(requested.provider);
  const requestedModel = normalizeString(requested.model);
  if (requestedProvider && requestedProvider !== first.provider) {
    throw new Error(`providerFallback first target ${formatTarget(first)} does not match requested provider ${requestedProvider}`);
  }
  if (requestedModel && requestedModel !== first.model) {
    throw new Error(`providerFallback first target ${formatTarget(first)} does not match requested model ${requestedModel}`);
  }
  return first;
}

export function prepareProviderFallbackPolicy(
  value: unknown,
  evidence: readonly ProviderFallbackEvidence[],
): { policy: ProviderFallbackPolicy; targets: PreparedProviderFallbackTarget[] } | undefined {
  const policy = normalizeProviderFallbackPolicy(value);
  if (!policy) return undefined;
  const targets = policy.targets.map(target => {
    const matching = evidence.find(item => item.passed
      && item.provider === target.provider
      && (!target.model || item.model === target.model));
    if (policy.requireCompatibilityEvidence && !target.model) {
      throw new Error(`provider fallback target ${formatTarget(target)} must name a model when compatibility evidence is required`);
    }
    if (policy.requireCompatibilityEvidence && !matching) {
      throw new Error(`provider fallback target ${formatTarget(target)} requires passing compatibility evidence`);
    }
    return { ...target, compatibilityEvidenceId: matching?.id };
  });
  return { policy, targets };
}

export function createProviderFallbackRouter(input: {
  prepared: NonNullable<ReturnType<typeof prepareProviderFallbackPolicy>>;
  initialProvider: Provider;
  createProvider: (provider: string, options: CreateProviderOptions) => Provider;
  traceId?: string;
  onEvent: (event: ProviderFallbackEvent) => void | Promise<void>;
}): Provider {
  const providers = input.prepared.targets.map((target, index) => index === 0
    ? input.initialProvider
    : input.createProvider(target.provider, { model: target.model, traceId: input.traceId }));
  let currentIndex = 0;
  let switchCount = 0;
  let callIndex = 0;

  return {
    get name() { return providers[currentIndex]!.name; },
    get profile() { return providers[currentIndex]!.profile; },
    async chat(messages: Message[], tools?: ToolDef[], options?: ChatOptions): Promise<ProviderResponse> {
      callIndex++;
      while (true) {
        const current = providers[currentIndex]!;
        try {
          return await current.chat(messages, tools, options);
        } catch (error) {
          const failureClass = _classifyProviderFallbackFailure(error);
          if (!failureClass || !input.prepared.policy.onFailure.includes(failureClass)) throw error;
          const nextIndex = currentIndex + 1;
          const canSwitch = nextIndex < providers.length && switchCount < input.prepared.policy.maxSwitches;
          const errorCode = error instanceof AgentError ? error.code : undefined;
          const errorMessage = boundedErrorMessage(error);
          if (!canSwitch) {
            await input.onEvent({
              type: 'exhausted', callIndex, switchIndex: switchCount,
              failureClass, errorCode, errorMessage,
              fromProvider: current.name, fromModel: current.profile.model,
            });
            throw error;
          }
          const next = providers[nextIndex]!;
          const target = input.prepared.targets[nextIndex]!;
          switchCount++;
          await input.onEvent({
            type: 'selected', callIndex, switchIndex: switchCount,
            failureClass, errorCode, errorMessage,
            fromProvider: current.name, fromModel: current.profile.model,
            toProvider: next.name, toModel: next.profile.model,
            compatibilityEvidenceId: target.compatibilityEvidenceId,
          });
          currentIndex = nextIndex;
        }
      }
    },
  };
}

export function _classifyProviderFallbackFailure(error: unknown): ProviderFallbackFailureClass | undefined {
  if (error instanceof AgentError) {
    if (error.code === 'PROVIDER_NETWORK') return 'transport';
    if (error.context.httpStatus === 429) return 'rate_limit';
    if (error.context.httpStatus === 408 || (error.context.httpStatus ?? 0) >= 500) {
      return 'provider_unavailable';
    }
    return undefined;
  }
  if (error instanceof TypeError) return 'transport';
  return undefined;
}

function normalizeTarget(value: unknown, index: number): ProviderFallbackTarget {
  const target = asRecord(value);
  const provider = normalizeString(target.provider);
  const model = normalizeString(target.model);
  if (!provider) throw new Error(`providerFallback.targets[${index}].provider is required`);
  return { provider, model };
}

function normalizeFailureClasses(value: unknown): ProviderFallbackFailureClass[] {
  const allowed: ProviderFallbackFailureClass[] = ['transport', 'rate_limit', 'provider_unavailable'];
  if (value === undefined) return allowed;
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error('providerFallback.onFailure must contain at least one failure class');
  }
  const normalized = value.map(item => normalizeString(item));
  if (normalized.some(item => !item || !allowed.includes(item as ProviderFallbackFailureClass))) {
    throw new Error(`providerFallback.onFailure supports only: ${allowed.join(', ')}`);
  }
  return [...new Set(normalized)] as ProviderFallbackFailureClass[];
}

function formatTarget(target: ProviderFallbackTarget): string {
  return target.model ? `${target.provider}:${target.model}` : target.provider;
}

function boundedErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, 500);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function normalizeString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  return normalized || undefined;
}

function normalizeInteger(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return Math.floor(value);
}
