export interface DiscoveredTool {
  name: string;
  installed: boolean;
  configPath: string;
  version?: string;
  lastUsed?: string;
}

export interface DiscoveredProvider {
  name: string;
  apiKey?: string;
  baseUrl?: string;
  defaultModel?: string;
  apiShape?: string;
  /** Credential class — set to 'oauth' for OAuth-based providers so
   *  getProviderConfig() resolves tokens at runtime instead of requiring an
   *  explicit apiKey. */
  authMode?: 'oauth' | 'api_key';
  available: boolean;
  source: string;
  sourceTool?: string;
  importable: boolean;
  note?: string;
}

export type GrokAccountAuthMode = 'oidc' | 'external' | 'api_key' | 'legacy' | 'unknown';
export type GrokAccountSourceKind = 'inline_env' | 'explicit_path' | 'grok_home' | 'default_home';

export interface GrokAccountCandidate {
  candidateId: 'xai-grok-default';
  provider: 'xai';
  runtimeKind: 'grok';
  available: boolean;
  cliInstalled: boolean;
  authMode: GrokAccountAuthMode | null;
  sourceKind: GrokAccountSourceKind;
  reason: string | null;
}

export type ProviderPromotionState =
  | 'blocked'
  | 'advisory'
  | 'verified_advisory'
  | 'required';

export interface ProviderReadiness {
  configuredKey: boolean;
  discovered: boolean;
  ready: boolean;
  manualSetupRequired: boolean;
  blocker: string | null;
  promotionState: ProviderPromotionState;
  credentialClass: 'api_key' | 'oauth' | 'local_endpoint' | 'cli_adapter' | 'unknown';
  setupAction: string | null;
}

export interface ProviderReadinessSummary {
  configuredKeys: number;
  discoveredProviders: number;
  readyProviders: number;
  manualSetupBlockers: number;
}

export interface DiscoveryReport {
  tools: DiscoveredTool[];
  providers: DiscoveredProvider[];
  summary: string;
}

export interface CodexRouteConfig {
  providerName: string;
  baseUrl: string;
  model?: string;
  wireApi?: string;
}
