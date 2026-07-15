import { execFileSync } from 'node:child_process';
import type { CodexRouteConfig, DiscoveredProvider } from './types.js';
import { parseJsonObject, readString } from './helpers.js';
import { requireProviderDefaults } from '../provider-defaults.js';

export function parseCodexRouteConfig(toml: string): CodexRouteConfig {
  const openaiDefaults = requireProviderDefaults('openai');
  const model = toml.match(/^model\s*=\s*"(.+)"$/m)?.[1];
  const providerId = toml.match(/^model_provider\s*=\s*"(.+)"$/m)?.[1];
  let baseUrl = openaiDefaults.baseUrl;
  let providerName = 'openai';
  let wireApi: string | undefined;

  if (providerId) {
    const section = new RegExp(`\\[model_providers\\.${providerId}\\]\\n(.*?)(?=\\n\\[|$)`, 's');
    const sectionMatch = toml.match(section);
    if (sectionMatch) {
      baseUrl = sectionMatch[1].match(/^base_url\s*=\s*"(.+)"$/m)?.[1] ?? baseUrl;
      providerName = sectionMatch[1].match(/^name\s*=\s*"(.+)"$/m)?.[1] ?? providerName;
      wireApi = sectionMatch[1].match(/^wire_api\s*=\s*"(.+)"$/m)?.[1];
    }
  }

  if (baseUrl.includes('packyapi.com') || providerName.toLowerCase() === 'packycode') {
    providerName = 'packycode';
    // PackyCode does not support the OpenAI Responses API endpoint (/v1/responses).
    // Codex may set wire_api="responses" for its own internal routing, but that
    // format is not available through the PackyCode proxy — force Chat Completions.
    wireApi = undefined;
  }

  return { providerName, baseUrl, model, ...(wireApi ? { wireApi } : {}) };
}

function mapWireApiToShape(wireApi?: string): string | undefined {
  if (!wireApi) return undefined;
  switch (wireApi.toLowerCase()) {
    case 'responses':
      return 'openai-responses';
    default:
      return undefined;
  }
}

export function parseCcSwitchRowsWithCli(dbPath: string): Array<Record<string, any>> {
  const output = execFileSync('sqlite3', [
    '-json',
    dbPath,
    'SELECT app_type, name, settings_config, is_current FROM providers ORDER BY is_current DESC',
  ], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] });
  return JSON.parse(output || '[]') as Array<Record<string, any>>;
}

function extractApiKeyFromCodexAuth(auth: Record<string, any> | null): string | undefined {
  return readString(auth?.OPENAI_API_KEY) ?? readString(auth?.tokens?.access_token);
}

export function ccSwitchProviderFromRow(row: Record<string, any>): DiscoveredProvider | null {
  const config = parseJsonObject(row.settings_config) ?? {};
  const env = parseJsonObject(config.env) ?? {};
  const appType = readString(row.app_type)?.toLowerCase();
  const accountName = readString(row.name) ?? 'default';
  const isCurrent = row.is_current === 1 || row.is_current === true;

  if (appType === 'codex') {
    const route = readString(config.config)
      ? parseCodexRouteConfig(config.config)
      : {
          providerName: 'openai',
          baseUrl: requireProviderDefaults('openai').baseUrl,
          model: undefined,
          wireApi: undefined,
        };
    const auth = parseJsonObject(config.auth);
    const apiKey = extractApiKeyFromCodexAuth(auth);
    if (!apiKey) return null;
    return {
      name: route.providerName,
      apiKey,
      baseUrl: route.baseUrl,
      defaultModel: route.model,
      apiShape: mapWireApiToShape(route.wireApi),
      available: true,
      source: `cc-switch/codex/${accountName}`,
      sourceTool: 'cc-switch',
      importable: true,
      note: isCurrent ? 'Currently active in cc-switch' : undefined,
    };
  }

  if (appType === 'claude') {
    const apiKey = readString(env.ANTHROPIC_AUTH_TOKEN);
    const baseUrl = readString(env.ANTHROPIC_BASE_URL);
    if (!apiKey || !baseUrl) return null;

    const lowerName = accountName.toLowerCase();
    const lowerBaseUrl = baseUrl.toLowerCase();
    let providerName: string | null = null;
    if (lowerBaseUrl.includes('deepseek.com') || lowerName.includes('deepseek')) {
      providerName = 'deepseek-anthropic';
    } else if (lowerBaseUrl.includes('minimax') || lowerName.includes('minimax')) {
      providerName = 'minimax';
    }
    if (!providerName) return null;

    return {
      name: providerName,
      apiKey,
      baseUrl,
      defaultModel: readString(env.ANTHROPIC_MODEL)
        ?? readString(env.ANTHROPIC_DEFAULT_SONNET_MODEL_NAME)
        ?? readString(env.ANTHROPIC_DEFAULT_SONNET_MODEL)
        ?? readString(env.ANTHROPIC_DEFAULT_HAIKU_MODEL),
      available: true,
      source: `cc-switch/claude/${accountName}`,
      sourceTool: 'cc-switch',
      importable: true,
      note: isCurrent ? 'Currently active in cc-switch' : undefined,
    };
  }

  const apiKey = readString(config.api_key) ?? readString(config.apiKey);
  if (!apiKey) return null;
  const providerMap: Record<string, string> = {
    opencode: readString(config.provider) ?? 'anthropic',
    gemini: 'google',
  };
  return {
    name: providerMap[appType ?? ''] ?? appType ?? accountName.toLowerCase(),
    apiKey,
    baseUrl: readString(config.base_url) ?? readString(config.baseUrl),
    defaultModel: readString(config.model),
    available: true,
    source: `cc-switch/${accountName}`,
    sourceTool: 'cc-switch',
    importable: true,
    note: isCurrent ? 'Currently active in cc-switch' : undefined,
  };
}
