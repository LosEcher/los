import { resolveModelProfile } from './model-profiles.js';

export interface ProviderRequestConfig {
  enabled?: boolean;
  baseUrl?: string;
  model?: string;
}

export interface ProviderRequestValidationInput {
  provider?: string | null;
  model?: string | null;
  defaultProvider: string;
  defaultModel?: string;
  configuredProviders: Readonly<Record<string, ProviderRequestConfig>>;
}

export interface ProviderRequestValidationSuccess {
  valid: true;
  provider: string;
  model: string;
}

export interface ProviderRequestValidationFailure {
  valid: false;
  code: 'provider_required_for_model' | 'provider_not_configured' | 'model_not_configured';
  message: string;
}

export type ProviderRequestValidationResult =
  | ProviderRequestValidationSuccess
  | ProviderRequestValidationFailure;

/** Validate the explicit provider/model pair before creating a durable run. */
export function validateProviderModelRequest(
  input: ProviderRequestValidationInput,
): ProviderRequestValidationResult {
  const provider = normalize(input.provider);
  const model = normalize(input.model);
  if (model && !provider) {
    return {
      valid: false,
      code: 'provider_required_for_model',
      message: 'model requires an explicit provider',
    };
  }

  const selectedProvider = provider ?? input.defaultProvider.trim();
  const config = findProviderConfig(input.configuredProviders, selectedProvider);
  if (!config || config.enabled === false) {
    return {
      valid: false,
      code: 'provider_not_configured',
      message: `provider '${selectedProvider}' is not configured or disabled`,
    };
  }

  const profile = resolveModelProfile(selectedProvider, {
    baseUrl: config.baseUrl,
    model: config.model,
    defaultModel: input.defaultModel,
  });
  const effectiveModel = model ?? normalize(config.model) ?? profile.model;
  const acceptedModels = new Set(
    [profile.model, ...(profile.modelAliases ?? []), normalize(config.model)].filter(
      (value): value is string => Boolean(value),
    ),
  );
  if (model && !acceptedModels.has(model)) {
    return {
      valid: false,
      code: 'model_not_configured',
      message: `model '${model}' is not configured for provider '${selectedProvider}'`,
    };
  }

  return { valid: true, provider: selectedProvider, model: effectiveModel };
}

function findProviderConfig(
  providers: Readonly<Record<string, ProviderRequestConfig>>,
  provider: string,
): ProviderRequestConfig | undefined {
  return providers[provider] ?? providers[provider.toLowerCase()];
}

function normalize(value: string | null | undefined): string | undefined {
  const result = value?.trim();
  return result || undefined;
}
