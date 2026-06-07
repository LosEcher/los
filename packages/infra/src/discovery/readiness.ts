import type { DiscoveredProvider, ProviderReadiness, ProviderReadinessSummary } from './types.js';

const PROVIDER_API_KEY_ENV: Record<string, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  deepseek: 'DEEPSEEK_API_KEY',
  'deepseek-anthropic': 'DEEPSEEK_API_KEY',
  minimax: 'MINIMAX_API_KEY',
  moonshot: 'MOONSHOT_API_KEY',
  openai: 'OPENAI_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
  qwen: 'DASHSCOPE_API_KEY',
};

export function providerApiKeyEnv(providerName: string): string {
  const normalized = providerName.trim().toLowerCase();
  return PROVIDER_API_KEY_ENV[normalized]
    ?? `${providerName.trim().toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_API_KEY`;
}

function inferCredentialClass(
  provider: DiscoveredProvider,
): ProviderReadiness['credentialClass'] {
  const source = provider.source?.toLowerCase() ?? '';
  if (source.includes('env:')) return 'api_key';
  if (source.includes('oauth') || source.includes('claude.json')) return 'oauth';
  if (source.includes('ollama') || source.includes('lm-studio') || source.includes('vllm')) return 'local_endpoint';
  if (source.includes('cc-switch') || source.includes('hermes/.env')) return 'api_key';
  if (source.includes('codex') || source.includes('cli')) return 'cli_adapter';
  return 'unknown';
}

function describeSetupAction(provider: DiscoveredProvider): string | null {
  const keyEnv = providerApiKeyEnv(provider.name);
  const credentialClass = inferCredentialClass(provider);

  if (credentialClass === 'api_key') {
    return `export ${keyEnv}="<your-${provider.name}-api-key>"  # or add to ~/.los/accounts/${provider.name}.json`;
  }
  if (credentialClass === 'oauth') {
    return `${provider.name} requires OAuth. Run 'claude login' or configure via ~/.claude.json`;
  }
  if (credentialClass === 'local_endpoint') {
    return `${provider.name} is a local endpoint. Ensure the service is running and reachable.`;
  }
  if (credentialClass === 'cli_adapter') {
    return `Run 'codex setup' or ensure ~/.codex/auth.json has valid credentials for ${provider.name}`;
  }
  return `Set ${keyEnv} or configure via ~/.los/accounts/${provider.name}.json`;
}

export function describeProviderReadiness(provider: DiscoveredProvider): ProviderReadiness {
  const configuredKey = typeof provider.apiKey === 'string' && provider.apiKey.length > 0;
  const ready = provider.available && provider.importable && configuredKey;
  const manualSetupRequired = !ready;
  const credentialClass = inferCredentialClass(provider);

  let promotionState: ProviderReadiness['promotionState'] = 'blocked';
  let blocker: string | null = null;

  if (!configuredKey || !provider.importable) {
    promotionState = 'blocked';
    const keyEnv = providerApiKeyEnv(provider.name);
    blocker = `${keyEnv} not set. ${credentialClass === 'oauth' ? 'OAuth required.' : credentialClass === 'local_endpoint' ? 'Local endpoint unreachable.' : `Set ${keyEnv} to unlock ${provider.name}.`}`;
  } else if (ready) {
    promotionState = 'advisory';
  }

  return {
    configuredKey,
    discovered: true,
    ready,
    manualSetupRequired,
    blocker,
    promotionState,
    credentialClass,
    setupAction: manualSetupRequired ? describeSetupAction(provider) : null,
  };
}

export function summarizeProviderReadiness(providers: readonly DiscoveredProvider[]): ProviderReadinessSummary {
  const readiness = providers.map(describeProviderReadiness);
  return {
    configuredKeys: readiness.filter(r => r.configuredKey).length,
    discoveredProviders: providers.length,
    readyProviders: readiness.filter(r => r.ready).length,
    manualSetupBlockers: readiness.filter(r => r.manualSetupRequired).length,
  };
}
