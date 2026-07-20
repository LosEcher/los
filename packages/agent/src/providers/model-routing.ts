export type ModelRouteReason =
  | 'configured_default'
  | 'explicit_provider'
  | 'explicit_model'
  | 'explicit_fallback_policy'
  | 'architect_editor_override';

export interface ModelRouteDecision {
  requestedProvider?: string;
  requestedModel?: string;
  effectiveProvider: string;
  effectiveModel: string;
  reason: ModelRouteReason;
}

export interface ResolveModelRouteDecisionInput {
  requestedProvider?: string;
  requestedModel?: string;
  effectiveProvider: string;
  effectiveModel: string;
  architectEditorOverride?: boolean;
  explicitFallbackPolicy?: boolean;
}

export function resolveModelRouteDecision(
  input: ResolveModelRouteDecisionInput,
): ModelRouteDecision {
  const requestedProvider = normalizeOptionalString(input.requestedProvider);
  const requestedModel = normalizeOptionalString(input.requestedModel);
  const reason: ModelRouteReason = input.architectEditorOverride
    ? 'architect_editor_override'
    : input.explicitFallbackPolicy
      ? 'explicit_fallback_policy'
      : requestedModel
        ? 'explicit_model'
        : requestedProvider
          ? 'explicit_provider'
          : 'configured_default';

  return {
    requestedProvider,
    requestedModel,
    effectiveProvider: input.effectiveProvider,
    effectiveModel: input.effectiveModel,
    reason,
  };
}

function normalizeOptionalString(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized || undefined;
}
