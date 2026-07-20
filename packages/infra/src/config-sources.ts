import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import YAML from 'yaml';
import { getLogger } from './logger.js';
import { discoverAll } from './discovery.js';
import { providerDefaultsForApiKeyEnv } from './provider-defaults.js';

const log = getLogger('config');

const ENV_MAP: [string, string][] = [
  ['LOS_VERSION', 'server.version'], ['DATABASE_URL', 'databaseUrl'],
  ['SERVER_PORT', 'server.port'], ['SERVER_HOST', 'server.host'],
  ['CORS_ORIGIN', 'server.corsOrigin'], ['LOS_AUTH_ENABLED', 'auth.enabled'],
  ['LOS_AUTH_TOKEN', 'auth.token'], ['LOS_OPERATOR_TOKEN', 'auth.operatorToken'],
  ['LOS_FEED_ANALYSIS_TOKEN', 'integrations.feedAnalysis.serviceToken'],
  ['LOS_FEED_ANALYSIS_RESULT_RETURNING', 'integrations.feedAnalysis.resultReturningEnabled'],
  ['LOS_FEED_ANALYSIS_MAX_INLINE_BYTES', 'integrations.feedAnalysis.maxInlineBytes'],
  ['LOS_FEED_ANALYSIS_MAX_ITEMS', 'integrations.feedAnalysis.maxItems'],
  ['LOS_FEED_ANALYSIS_MATERIAL_HOSTS', 'integrations.feedAnalysis.materialHosts'],
  ['LOS_FEED_ANALYSIS_MATERIAL_TIMEOUT_MS', 'integrations.feedAnalysis.materialFetchTimeoutMs'],
  ['LOS_FEED_ANALYSIS_EXECUTION_TIMEOUT_MS', 'integrations.feedAnalysis.executionTimeoutMs'],
  ['LOS_FEED_ANALYSIS_CALLBACK_POLL_MS', 'integrations.feedAnalysis.callbackPollMs'],
  ['AGENT_DEFAULT_PROVIDER', 'agent.defaultProvider'], ['AGENT_DEFAULT_MODEL', 'agent.defaultModel'],
  ['AGENT_MAX_LOOPS', 'agent.maxLoops'], ['AGENT_SANDBOX_MODE', 'agent.sandboxMode'],
  ['AGENT_SYSTEM_PROMPT', 'agent.systemPrompt'], ['AGENT_IDENTITY_NAME', 'agent.identity.name'],
  ['AGENT_IDENTITY_LEVEL', 'agent.identity.level'], ['JUDGE_SYSTEM_PROMPT', 'judge.systemPrompt'],
  ['REVIEW_ENABLED', 'review.enabled'], ['MEMORY_FTS_ENABLED', 'memory.ftsEnabled'],
  ['MEMORY_PERSIST_CHAT_DEFAULT', 'memory.persistChatDefault'],
  ['MEMORY_SELF_REFLECTION_ENABLED', 'memory.selfReflectionEnabled'],
  ['LOS_CODE_GRAPH_ENABLED', 'memory.codeGraph.enabled'],
  ['LOS_CODE_GRAPH_SHADOW_MODE', 'memory.codeGraph.shadowMode'],
  ['LOS_CODE_GRAPH_INJECT_ARCH', 'memory.codeGraph.injectArchitecture'],
  ['LOS_CBM_COMMAND', 'memory.codeGraph.cbmCommand'], ['EXECUTOR_ENABLED', 'executor.enabled'],
  ['EXECUTOR_VERSION', 'executor.version'], ['EXECUTOR_AGENT_KEY', 'executor.agentKey'],
  ['EXECUTOR_NODE_ID', 'executor.nodeId'], ['EXECUTOR_NODE_URL', 'executor.nodeUrl'],
  ['EXECUTOR_NODE_KIND', 'executor.nodeKind'], ['EXECUTOR_HOST', 'executor.host'],
  ['EXECUTOR_PORT', 'executor.port'], ['EXECUTOR_SHUTDOWN_GRACE_MS', 'executor.shutdownGraceMs'],
  ['GATEWAY_URL', 'executor.gatewayUrl'], ['EXECUTOR_ARTIFACT_ROOT', 'executor.artifactRoot'],
  ['EXECUTOR_CONNECT_MODES', 'executor.connectModes'], ['EXECUTOR_MESH_NODES', 'executor.meshNodes'],
  ['LOS_PROFILE', 'profile'], ['LOS_DEFAULT_PROJECT_ID', 'defaultProjectId'],
];

export function knownEnvKeys(): readonly string[] {
  return ENV_MAP.map(([key]) => key);
}

export function loadEnvFile(cwd: string): Record<string, string> {
  const envPath = findUp(cwd, '.env');
  if (!existsSync(envPath)) return {};
  const result: Record<string, string> = {};
  try {
    const content = readFileSync(envPath, 'utf-8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx === -1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      let value = trimmed.slice(eqIdx + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
      result[key] = value;
      if (!(key in process.env)) process.env[key] = value;
    }
  } catch { /* ignore malformed optional env files */ }
  return result;
}

function findUp(start: string, filename: string): string {
  let current = resolve(start);
  while (true) {
    const candidate = join(current, filename);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(current);
    if (parent === current) return candidate;
    current = parent;
  }
}

function loadYamlConfig(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) return null;
  try { return YAML.parse(readFileSync(path, 'utf-8')) ?? {}; }
  catch (e: any) { log.warn(`Failed to parse ${path}: ${e.message}`); return null; }
}

export function loadUserConfig(): Record<string, unknown> | null {
  for (const p of [join(homedir(), '.los', 'config.yaml'), join(homedir(), '.los', 'config.yml')]) {
    const cfg = loadYamlConfig(p);
    if (cfg) return cfg;
  }
  return null;
}

export function loadSystemConfig(): Record<string, unknown> | null {
  for (const p of ['/etc/los/config.yaml', '/etc/los/config.yml']) {
    const cfg = loadYamlConfig(p);
    if (cfg) return cfg;
  }
  return null;
}

function setNested(obj: Record<string, any>, path: string, value: unknown): void {
  const parts = path.split('.');
  let current = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (!(parts[i] in current)) current[parts[i]] = {};
    current = current[parts[i]];
  }
  current[parts[parts.length - 1]] = value;
}

export function flattenEnv(env: Record<string, string>, sourceLabel = 'env'): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [envKey, configPath] of ENV_MAP) {
    const val = env[envKey];
    if (val !== undefined && val !== '') {
      const arrayPath = configPath === 'executor.meshNodes' || configPath === 'executor.connectModes'
        || configPath === 'integrations.feedAnalysis.materialHosts';
      setNested(result, configPath, arrayPath ? val.split(',').map(s => s.trim()).filter(Boolean) : val);
    }
  }
  for (const [key, value] of Object.entries(env)) {
    const match = key.match(/^([A-Z_]+)_API_KEY$/);
    if (match && value) {
      const provider = providerDefaultsForApiKeyEnv(key)?.name ?? match[1].toLowerCase();
      if (!result.providers) result.providers = {};
      (result.providers as any)[provider] = { apiKey: value, enabled: true, source: `${sourceLabel}:${key}` };
    }
  }
  return result;
}

export async function mergeDiscoveredProviders(config: Record<string, unknown>): Promise<Record<string, unknown>> {
  const { providers: discovered } = await discoverAll();
  if (!config.providers) config.providers = {};
  const providers = config.providers as Record<string, any>;
  for (const dp of discovered) {
    if (!providers[dp.name]) providers[dp.name] = {};
    const p = providers[dp.name];
    if (!p.apiKey && dp.apiKey) p.apiKey = dp.apiKey;
    if (!p.baseUrl && dp.baseUrl) p.baseUrl = dp.baseUrl;
    if (!p.model && dp.defaultModel) p.model = dp.defaultModel;
    if (!p.apiShape && dp.apiShape) p.apiShape = dp.apiShape;
    if (!p.authMode && dp.authMode) p.authMode = dp.authMode;
    if (p.enabled === undefined) p.enabled = dp.available;
    if (!p.source && dp.source) p.source = dp.source;
  }
  return config;
}

export function deepMerge(target: Record<string, unknown>, source: Record<string, unknown>): Record<string, unknown> {
  const result = { ...target };
  for (const [key, val] of Object.entries(source)) {
    if (val && typeof val === 'object' && !Array.isArray(val) && result[key]
      && typeof result[key] === 'object' && !Array.isArray(result[key])) {
      result[key] = deepMerge(result[key] as Record<string, unknown>, val as Record<string, unknown>);
    } else result[key] = val;
  }
  return result;
}
