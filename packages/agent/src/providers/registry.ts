import { getConfig } from '@los/infra/config';
import { resolveModelProfile, type ApiShape } from '../model-profiles.js';
import { createAnthropicProvider } from './anthropic.js';
import { createOpenAIResponsesProvider } from './responses.js';
import { getProviderConfig, createOpenAICompatProvider, diag } from './index.js';
import type { Provider, CreateProviderOptions } from './types.js';
import { resolveXaiOAuthCredential } from '../auth/xai-oauth.js';

export function createProvider(name?: string, options: CreateProviderOptions = {}): Provider {
  const config = getConfig();
  const providerName = name ?? config.agent.defaultProvider;

  const p = getProviderConfig(providerName);
  let credentialResolver: typeof resolveXaiOAuthCredential | undefined;
  if (!p.apiKey && p.authMode === 'oauth') {
    if (providerName !== 'xai') {
      throw new Error(`Provider '${providerName}' has no supported OAuth credential resolver.`);
    }
    credentialResolver = () => resolveXaiOAuthCredential();
  }
  const apiShapeOverride = (options.apiShape ?? (p as Record<string, unknown>).apiShape) as ApiShape | undefined;
  const profile = resolveModelProfile(providerName, {
    baseUrl: options.baseUrl ?? p.baseUrl,
    model: options.model ?? p.model,
    defaultModel: config.agent.defaultModel,
    apiShape: apiShapeOverride,
  });

  diag(options.traceId, `createProvider name=${providerName}`, {
    protocol: profile.protocol,
    apiShape: profile.apiShape,
  } as Record<string, unknown>);

  if (profile.protocol === 'anthropic') {
    if (credentialResolver) throw new Error(`Provider '${providerName}' OAuth is not supported by the Anthropic transport.`);
    return createAnthropicProvider({
      name: providerName,
      apiKey: p.apiKey!,
      profile,
      traceId: options.traceId,
    });
  }

  if (profile.apiShape === 'openai-responses') {
    if (credentialResolver) throw new Error(`Provider '${providerName}' OAuth is not supported by the Responses transport.`);
    return createOpenAIResponsesProvider({
      name: providerName,
      apiKey: p.apiKey!,
      profile,
      traceId: options.traceId,
    });
  }

  return createOpenAICompatProvider({
    name: providerName,
    apiKey: p.apiKey,
    profile,
    traceId: options.traceId,
    credentialResolver,
  });
}

export function createDeepSeekProvider(): Provider {
  const p = getProviderConfig('deepseek');
  const profile = resolveModelProfile('deepseek', {
    baseUrl: p.baseUrl,
    model: p.model,
    defaultModel: getConfig().agent.defaultModel,
  });
  return createOpenAICompatProvider({
    name: 'deepseek',
    apiKey: p.apiKey!,
    profile,
  });
}

export function createOpenAIProvider(): Provider | null {
  try {
    const p = getProviderConfig('openai');
    const profile = resolveModelProfile('openai', {
      baseUrl: p.baseUrl,
      model: p.model,
      defaultModel: getConfig().agent.defaultModel,
    });
    return createOpenAICompatProvider({
      name: 'openai',
      apiKey: p.apiKey!,
      profile,
    });
  } catch { return null; }
}
