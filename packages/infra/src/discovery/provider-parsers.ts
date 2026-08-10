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

  if (
    baseUrl.includes('packyapi.com')
    || baseUrl.includes('api.fan')
    || providerName.toLowerCase() === 'packycode'
  ) {
    providerName = 'packycode';
    // Codex Packy GPT routes historically forced chat completions. Keep wire_api
    // when the operator explicitly set responses (some Packy models need it);
    // Grok-on-Packy is discovered from grokbuild rows with api_backend=responses.
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

/**
 * Parse cc-switch grokbuild TOML settings (PackyCode Grok uses responses API).
 *
 * Example:
 *   [models]
 *   default = "grok-4.5"
 *   [model."grok-4.5"]
 *   model = "grok-4.5"
 *   api_backend = "responses"
 *   api_key = "sk-..."
 *   [endpoints]
 *   models_base_url = "https://slb-v1.api.fan/v1"
 */
export function parseGrokbuildConfig(toml: string): {
  defaultModel?: string;
  apiKey?: string;
  baseUrl?: string;
  apiBackend?: string;
  modelName?: string;
} {
  const defaultModel = toml.match(/^default\s*=\s*"(.+)"$/m)?.[1]
    ?? toml.match(/\[models\][\s\S]*?^default\s*=\s*"(.+)"$/m)?.[1];
  const endpointsBase = toml.match(/models_base_url\s*=\s*"(.+)"/m)?.[1];
  // Prefer the default model section for api_key / backend.
  let apiKey: string | undefined;
  let apiBackend: string | undefined;
  let modelName: string | undefined;
  if (defaultModel) {
    const escaped = defaultModel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const section = new RegExp(
      `\\[model\\."${escaped}"\\]\\n(.*?)(?=\\n\\[|$)`,
      's',
    );
    const body = toml.match(section)?.[1] ?? '';
    apiKey = body.match(/^api_key\s*=\s*"(.+)"$/m)?.[1];
    apiBackend = body.match(/^api_backend\s*=\s*"(.+)"$/m)?.[1];
    modelName = body.match(/^model\s*=\s*"(.+)"$/m)?.[1] ?? defaultModel;
  }
  if (!apiKey) {
    apiKey = toml.match(/^api_key\s*=\s*"(.+)"$/m)?.[1];
  }
  if (!apiBackend) {
    apiBackend = toml.match(/^api_backend\s*=\s*"(.+)"$/m)?.[1];
  }
  return {
    defaultModel: modelName ?? defaultModel,
    apiKey,
    baseUrl: endpointsBase,
    apiBackend,
    modelName,
  };
}

function isPackyHost(value: string | undefined, accountName: string): boolean {
  const hay = `${value ?? ''} ${accountName}`.toLowerCase();
  return hay.includes('packy') || hay.includes('api.fan') || hay.includes('packyapi');
}

export function ccSwitchProviderFromRow(row: Record<string, any>): DiscoveredProvider | null {
  const config = parseJsonObject(row.settings_config) ?? {};
  const env = parseJsonObject(config.env) ?? {};
  const appType = readString(row.app_type)?.toLowerCase();
  const accountName = readString(row.name) ?? 'default';
  const isCurrent = row.is_current === 1 || row.is_current === true;

  if (appType === 'grokbuild' || appType === 'grok') {
    const toml = readString(config.config) ?? '';
    if (!toml) return null;
    const parsed = parseGrokbuildConfig(toml);
    if (!parsed.apiKey) return null;
    const packy = isPackyHost(parsed.baseUrl, accountName);
    const apiShape = parsed.apiBackend?.toLowerCase() === 'responses'
      ? 'openai-responses'
      : undefined;
    // PackyCode Grok (cc-switch current) → packycode provider so los uses the
    // same operator route; native xAI OAuth remains the separate `xai` entry.
    const name = packy ? 'packycode' : 'xai';
    return {
      name,
      apiKey: parsed.apiKey,
      baseUrl: parsed.baseUrl ?? (packy ? undefined : requireProviderDefaults('xai').baseUrl),
      defaultModel: parsed.defaultModel ?? requireProviderDefaults('xai').defaultModel,
      apiShape,
      available: true,
      source: `cc-switch/grokbuild/${accountName}`,
      sourceTool: 'cc-switch',
      importable: true,
      prefer: isCurrent,
      note: isCurrent
        ? 'Currently active in cc-switch (grokbuild)'
        : 'cc-switch grokbuild account',
    };
  }

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
      // Keep wire_api for non-packy; packy codex GPT often needs chat.
      // Grok-on-packy is handled by grokbuild rows (responses).
      apiShape: mapWireApiToShape(route.wireApi),
      available: true,
      source: `cc-switch/codex/${accountName}`,
      sourceTool: 'cc-switch',
      importable: true,
      prefer: isCurrent,
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
