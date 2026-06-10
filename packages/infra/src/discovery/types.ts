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
  available: boolean;
  source: string;
  sourceTool?: string;
  importable: boolean;
  note?: string;
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
