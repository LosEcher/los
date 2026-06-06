/**
 * @los/infra/discovery — Provider & tool auto-discovery (onboarding scanner).
 *
 * Scans the local machine for existing AI tool configurations:
 *   - Codex CLI:    ~/.codex/config.toml + ~/.codex/auth.json
 *   - Claude Code:  ~/.claude.json (OAuth), ~/.claude/settings.json
 *   - OpenCode:     ~/.config/opencode/opencode.json
 *   - cc-switch:    ~/.cc-switch/cc-switch.db (SQLite)
 *   - Hermes:       ~/.hermes/.env + ~/.hermes/config.yaml
 *   - Cloud keys:   *_API_KEY env vars
 *   - Local models: Ollama (:11434), LM Studio (:1234), vLLM (:8000)
 *   - Own accounts: ~/.los/accounts/*.json
 *
 * Inspired by:
 *   - Hermes Agent's `claw migrate` auto-detection
 *   - OpenClaw's provider discovery flow
 *   - cc-switch's multi-tool config sync
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { getLogger } from './logger.js';

const require = createRequire(import.meta.url);

const log = getLogger('discovery');

// ── Types ───────────────────────────────────────────────

export interface DiscoveredTool {
  name: string;                // 'codex' | 'claude' | 'opencode' | 'cc-switch' | 'hermes'
  installed: boolean;
  configPath: string;
  version?: string;
  lastUsed?: string;           // mtime of config file
}

export interface DiscoveredProvider {
  name: string;
  apiKey?: string;
  baseUrl?: string;
  defaultModel?: string;
  available: boolean;
  source: string;              // e.g. 'codex/auth.json', 'claude/oauth', 'env:DEEPSEEK_API_KEY'
  sourceTool?: string;         // which tool this came from
  importable: boolean;         // can we actually use this key?
  note?: string;
}

export type ProviderPromotionState =
  | 'blocked'              // No API key configured
  | 'advisory'             // Key configured but not yet verified by a live run
  | 'verified_advisory'    // One live passing run with task_runs/session_events evidence
  | 'required';            // Included in DEFAULT_COMPATIBILITY_TARGETS merge gate

export interface ProviderReadiness {
  configuredKey: boolean;
  discovered: boolean;
  ready: boolean;
  manualSetupRequired: boolean;
  blocker: string | null;
  promotionState: ProviderPromotionState;
  credentialClass: 'api_key' | 'oauth' | 'local_endpoint' | 'cli_adapter' | 'unknown';
  setupAction: string | null;  // Human-readable setup instruction
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

  let promotionState: ProviderPromotionState = 'blocked';
  let blocker: string | null = null;

  if (!configuredKey || !provider.importable) {
    promotionState = 'blocked';
    const keyEnv = providerApiKeyEnv(provider.name);
    blocker = `${keyEnv} not set. ${credentialClass === 'oauth' ? 'OAuth required.' : credentialClass === 'local_endpoint' ? 'Local endpoint unreachable.' : `Set ${keyEnv} to unlock ${provider.name}.`}`;
  } else if (ready) {
    // Ready but not yet verified — stays advisory until a live compat run passes
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

// ── Tool Scanners ───────────────────────────────────────

function fileMtime(path: string): string | undefined {
  try { return statSync(path).mtime.toISOString(); } catch { return undefined; }
}

function fileAge(path: string): string | undefined {
  try {
    const age = Date.now() - statSync(path).mtimeMs;
    const days = Math.floor(age / (1000 * 60 * 60 * 24));
    if (days < 1) return 'today';
    if (days < 7) return `${days}d ago`;
    if (days < 30) return `${Math.floor(days / 7)}w ago`;
    return `${Math.floor(days / 30)}mo ago`;
  } catch { return undefined; }
}

interface CodexRouteConfig {
  providerName: string;
  baseUrl: string;
  model?: string;
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function parseJsonObject(value: unknown): Record<string, any> | null {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, any>;
  }
  if (typeof value !== 'string' || value.trim().length === 0) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, any>
      : null;
  } catch {
    return null;
  }
}

export function parseCodexRouteConfig(toml: string): CodexRouteConfig {
  const model = toml.match(/^model\s*=\s*"(.+)"$/m)?.[1];
  const providerId = toml.match(/^model_provider\s*=\s*"(.+)"$/m)?.[1];
  let baseUrl = 'https://api.openai.com/v1';
  let providerName = 'openai';

  if (providerId) {
    const section = new RegExp(`\\[model_providers\\.${providerId}\\]\\n(.*?)(?=\\n\\[|$)`, 's');
    const sectionMatch = toml.match(section);
    if (sectionMatch) {
      baseUrl = sectionMatch[1].match(/^base_url\s*=\s*"(.+)"$/m)?.[1] ?? baseUrl;
      providerName = sectionMatch[1].match(/^name\s*=\s*"(.+)"$/m)?.[1] ?? providerName;
    }
  }

  if (baseUrl.includes('packyapi.com') || providerName.toLowerCase() === 'packycode') {
    providerName = 'packycode';
  }

  return { providerName, baseUrl, model };
}

function parseCcSwitchRowsWithCli(dbPath: string): Array<Record<string, any>> {
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
          baseUrl: 'https://api.openai.com/v1',
          model: undefined,
        };
    const auth = parseJsonObject(config.auth);
    const apiKey = extractApiKeyFromCodexAuth(auth);
    if (!apiKey) return null;
    return {
      name: route.providerName,
      apiKey,
      baseUrl: route.baseUrl,
      defaultModel: route.model,
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

// ── 1. Codex CLI ────────────────────────────────────────

function scanCodex(): { tool: DiscoveredTool; providers: DiscoveredProvider[] } {
  const home = join(homedir(), '.codex');
  const authPath = join(home, 'auth.json');
  const configPath = join(home, 'config.toml');
  const providers: DiscoveredProvider[] = [];
  let route: CodexRouteConfig = {
    providerName: 'openai',
    baseUrl: 'https://api.openai.com/v1',
  };

  const installed = existsSync(home);
  const tool: DiscoveredTool = {
    name: 'codex',
    installed,
    configPath: home,
    lastUsed: fileAge(authPath) ?? fileAge(configPath),
  };

  if (!installed) return { tool, providers };

  if (existsSync(configPath)) {
    try {
      route = parseCodexRouteConfig(readFileSync(configPath, 'utf-8'));
    } catch { /* invalid toml */ }
  }

  // Parse auth.json
  if (existsSync(authPath)) {
    try {
      const auth = JSON.parse(readFileSync(authPath, 'utf-8'));
      tool.version = auth.auth_mode ?? 'unknown';

      if (auth.OPENAI_API_KEY) {
        providers.push({
          name: route.providerName,
          apiKey: auth.OPENAI_API_KEY,
          baseUrl: route.baseUrl,
          defaultModel: route.model ?? 'gpt-5.5',
          available: true,
          source: 'codex/auth.json',
          sourceTool: 'codex',
          importable: true,
        });
      }

      if (auth.tokens?.access_token) {
        providers.push({
          name: route.providerName,
          apiKey: auth.tokens.access_token,
          baseUrl: route.baseUrl,
          defaultModel: route.model ?? 'gpt-5.5',
          available: true,
          source: 'codex/auth.json (ChatGPT OAuth)',
          sourceTool: 'codex',
          importable: true,
          note: 'ChatGPT plan OAuth token — may expire',
        });
      }
    } catch { /* corrupt auth.json */ }
  }

  return { tool, providers };
}

// ── 2. Claude Code ──────────────────────────────────────

function scanClaude(): { tool: DiscoveredTool; providers: DiscoveredProvider[] } {
  const home = join(homedir(), '.claude');
  const oauthPath = join(homedir(), '.claude.json');
  const settingsPath = join(home, 'settings.json');
  const providers: DiscoveredProvider[] = [];

  const installed = existsSync(home) || existsSync(oauthPath);
  const tool: DiscoveredTool = {
    name: 'claude',
    installed,
    configPath: home,
    lastUsed: fileAge(settingsPath) ?? fileAge(oauthPath),
  };

  if (!installed) return { tool, providers };

  // Claude OAuth tokens — only usable by Claude CLI itself
  // Keep this as tool metadata only. OAuth/login state is not a LOS provider key.
  if (existsSync(oauthPath)) {
    try {
      const oauth = JSON.parse(readFileSync(oauthPath, 'utf-8'));
      const hasOAuth = !!(oauth.access_token || oauth.oauth_tokens);
      if (hasOAuth) tool.version = 'OAuth login detected';
    } catch { /* corrupt */ }
  }

  // Check for apiKeyHelper in settings
  if (existsSync(settingsPath)) {
    try {
      const settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
      if (settings.model) {
        tool.version = settings.model;
      } else if (settings.apiKeyHelper && !tool.version) {
        tool.version = 'apiKeyHelper configured';
      }
    } catch { /* corrupt */ }
  }

  return { tool, providers };
}

// ── 3. OpenCode ─────────────────────────────────────────

function scanOpenCode(): { tool: DiscoveredTool; providers: DiscoveredProvider[] } {
  const configPath = join(homedir(), '.config', 'opencode', 'opencode.json');
  const providers: DiscoveredProvider[] = [];

  const installed = existsSync(configPath);
  const tool: DiscoveredTool = {
    name: 'opencode',
    installed,
    configPath,
    lastUsed: fileAge(configPath),
  };

  if (!installed) return { tool, providers };

  try {
    const cfg = JSON.parse(readFileSync(configPath, 'utf-8'));
    const llm = cfg.llm;
    if (llm?.provider && llm?.apiKey) {
      providers.push({
        name: llm.provider,
        apiKey: llm.apiKey,
        baseUrl: llm.baseUrl,
        defaultModel: llm.model,
        available: true,
        source: 'opencode/opencode.json',
        sourceTool: 'opencode',
        importable: true,
      });
      tool.version = llm.model;
    }
  } catch { /* corrupt */ }

  return { tool, providers };
}

// ── 4. cc-switch ────────────────────────────────────────

function scanCcSwitch(): { tool: DiscoveredTool; providers: DiscoveredProvider[] } {
  const home = join(homedir(), '.cc-switch');
  const dbPath = join(home, 'cc-switch.db');
  const providers: DiscoveredProvider[] = [];

  const installed = existsSync(home);
  const tool: DiscoveredTool = {
    name: 'cc-switch',
    installed,
    configPath: home,
    lastUsed: fileAge(dbPath),
  };

  if (!installed || !existsSync(dbPath)) return { tool, providers };

  // Optional: read cc-switch's SQLite database if the parser is available.
  try {
    const Database = require('better-sqlite3');
    const db = new Database(dbPath, { readonly: true });
    const rows = db.prepare(`
      SELECT app_type, name, settings_config, is_current
      FROM providers ORDER BY is_current DESC
    `).all() as any[];

    for (const row of rows) {
      const provider = ccSwitchProviderFromRow(row);
      if (provider) providers.push(provider);
    }
    db.close();
    tool.version = `${rows.length} accounts`;
  } catch {
    try {
      const rows = parseCcSwitchRowsWithCli(dbPath);
      for (const row of rows) {
        const provider = ccSwitchProviderFromRow(row);
        if (provider) providers.push(provider);
      }
      tool.version = `${rows.length} accounts`;
    } catch {
      tool.version = 'SQLite db found (parser unavailable)';
    }
  }

  return { tool, providers };
}

// ── 5. Hermes ───────────────────────────────────────────

function scanHermes(): { tool: DiscoveredTool; providers: DiscoveredProvider[] } {
  const home = join(homedir(), '.hermes');
  const envPath = join(home, '.env');
  const configPath = join(home, 'config.yaml');
  const providers: DiscoveredProvider[] = [];

  const installed = existsSync(home);
  const tool: DiscoveredTool = {
    name: 'hermes',
    installed,
    configPath: home,
    lastUsed: fileAge(configPath) ?? fileAge(envPath),
  };

  if (!installed) return { tool, providers };

  // Hermes stores API keys in ~/.hermes/.env as KEY=VALUE
  if (existsSync(envPath)) {
    try {
      const content = readFileSync(envPath, 'utf-8');
      for (const line of content.split('\n')) {
        const match = line.match(/^([A-Z_]+_API_KEY)\s*=\s*(.+)$/);
        if (!match) continue;

        const envKey = match[1];
        const value = match[2].trim().replace(/^["']|["']$/g, '');

        // Map env key to provider name
        const keyMap: Record<string, { name: string; baseUrl?: string; model?: string }> = {
          'OPENROUTER_API_KEY': { name: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1', model: 'openai/gpt-4o' },
          'DEEPSEEK_API_KEY': { name: 'deepseek', baseUrl: 'https://api.deepseek.com', model: 'deepseek-v4-flash' },
          'OPENAI_API_KEY': { name: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'gpt-5.5' },
          'ANTHROPIC_API_KEY': { name: 'anthropic', baseUrl: 'https://api.anthropic.com' },
          'MINIMAX_API_KEY': { name: 'minimax', baseUrl: 'https://api.minimaxi.com/anthropic', model: 'MiniMax-M3' },
          'HF_TOKEN': { name: 'huggingface' },
          'GROQ_API_KEY': { name: 'groq', baseUrl: 'https://api.groq.com/openai/v1' },
        };

        const mapped = keyMap[envKey];
        if (mapped) {
          providers.push({
            name: mapped.name,
            apiKey: value,
            baseUrl: mapped.baseUrl,
            defaultModel: mapped.model,
            available: true,
            source: `hermes/.env (${envKey})`,
            sourceTool: 'hermes',
            importable: true,
          });
        }
      }
    } catch { /* corrupt */ }
  }

  // Also check config.yaml for provider endpoints
  if (existsSync(configPath)) {
    try {
      const YAML = require('yaml');
      const cfg = YAML.parse(readFileSync(configPath, 'utf-8'));
      if (cfg?.llm?.provider) {
        const existing = providers.find(p => p.name === cfg.llm.provider);
        if (existing) {
          if (cfg.llm.model) existing.defaultModel = cfg.llm.model;
          if (cfg.llm.base_url) existing.baseUrl = cfg.llm.base_url;
        }
      }
    } catch { /* skip */ }
  }

  return { tool, providers };
}

// ── Cloud API Keys from Env ─────────────────────────────

function scanEnvKeys(): DiscoveredProvider[] {
  const providers: DiscoveredProvider[] = [];

  const keyMap: Record<string, { name: string; baseUrl: string; model: string }> = {
    'DEEPSEEK_API_KEY':     { name: 'deepseek',   baseUrl: 'https://api.deepseek.com',              model: 'deepseek-v4-flash' },
    'OPENAI_API_KEY':       { name: 'openai',     baseUrl: 'https://api.openai.com/v1',             model: 'gpt-5.5' },
    'ANTHROPIC_API_KEY':    { name: 'anthropic',  baseUrl: 'https://api.anthropic.com',              model: 'claude-sonnet-4-20250514' },
    'MINIMAX_API_KEY':      { name: 'minimax',    baseUrl: 'https://api.minimaxi.com/anthropic',     model: 'MiniMax-M3' },
    'MOONSHOT_API_KEY':     { name: 'moonshot',   baseUrl: 'https://api.moonshot.cn/v1',              model: 'moonshot-v1-8k' },
    'ZHIPU_API_KEY':        { name: 'zhipu',      baseUrl: 'https://open.bigmodel.cn/api/paas/v4',   model: 'glm-4' },
    'DASHSCOPE_API_KEY':    { name: 'qwen',       baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-max' },
    'GROQ_API_KEY':         { name: 'groq',       baseUrl: 'https://api.groq.com/openai/v1',          model: 'llama-3.1-70b-versatile' },
    'TOGETHER_API_KEY':     { name: 'together',   baseUrl: 'https://api.together.xyz/v1',             model: 'meta-llama/Meta-Llama-3.1-70B-Instruct-Turbo' },
    'OPENROUTER_API_KEY':   { name: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1',             model: 'openai/gpt-4o' },
  };

  for (const [envKey, info] of Object.entries(keyMap)) {
    const value = process.env[envKey];
    if (value) {
      providers.push({
        name: info.name,
        apiKey: value,
        baseUrl: process.env[`${envKey.replace('_API_KEY', '')}_BASE_URL`] ?? info.baseUrl,
        defaultModel: process.env[`${envKey.replace('_API_KEY', '')}_MODEL`] ?? info.model,
        available: true,
        source: `env:${envKey}`,
        importable: true,
      });
    }
  }

  return providers;
}

// ── Local Endpoints ─────────────────────────────────────

async function checkEndpoint(url: string, timeout = 2000): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    return res.ok;
  } catch { return false; }
}

async function scanLocalEndpoints(): Promise<DiscoveredProvider[]> {
  const endpoints = [
    { name: 'ollama',    url: 'http://127.0.0.1:11434/api/tags', baseUrl: 'http://127.0.0.1:11434/v1', model: 'llama3.1' },
    { name: 'lmstudio',  url: 'http://127.0.0.1:1234/v1/models', baseUrl: 'http://127.0.0.1:1234/v1',   model: '(auto)' },
    { name: 'vllm',      url: 'http://127.0.0.1:8000/v1/models', baseUrl: 'http://127.0.0.1:8000/v1',     model: '(auto)' },
    { name: 'llamacpp',  url: 'http://127.0.0.1:8081/v1/models', baseUrl: 'http://127.0.0.1:8081/v1',     model: '(auto)' },
    { name: 'localai',   url: 'http://127.0.0.1:8082/v1/models', baseUrl: 'http://127.0.0.1:8082/v1',     model: '(auto)' },
  ];

  const results: DiscoveredProvider[] = [];
  for (const ep of endpoints) {
    if (await checkEndpoint(ep.url)) {
      results.push({
        name: ep.name,
        baseUrl: ep.baseUrl,
        defaultModel: ep.model,
        available: true,
        source: `local:${ep.url.split(':')[2].split('/')[0]}`,
        importable: true,
      });
    }
  }
  return results;
}

// ── Own Accounts (~/.los/accounts/) ─────────────────────

function scanOwnAccounts(): DiscoveredProvider[] {
  const dir = join(homedir(), '.los', 'accounts');
  if (!existsSync(dir)) return [];

  const providers: DiscoveredProvider[] = [];
  try {
    for (const file of readdirSync(dir)) {
      if (!file.endsWith('.json')) continue;
      try {
        const data = JSON.parse(readFileSync(join(dir, file), 'utf-8'));
        if (data.provider && data.api_key) {
          providers.push({
            name: data.provider,
            apiKey: data.api_key,
            baseUrl: data.base_url,
            defaultModel: data.model,
            available: true,
            source: `los/accounts/${file}`,
            importable: true,
          });
        }
      } catch { /* skip */ }
    }
  } catch { /* skip */ }

  return providers;
}

// ── Main Export ─────────────────────────────────────────

export async function discoverAll(): Promise<DiscoveryReport> {
  const tools: DiscoveredTool[] = [];
  const providers: DiscoveredProvider[] = [];

  // Phase 1: Scan all tools (sync)
  const scanners = [
    scanCodex(),
    scanClaude(),
    scanOpenCode(),
    scanCcSwitch(),
    scanHermes(),
  ];

  for (const result of scanners) {
    tools.push(result.tool);
    for (const p of result.providers) {
      // Deduplicate by provider name + source
      if (!providers.some(existing => existing.name === p.name && existing.source === p.source)) {
        providers.push(p);
      }
    }
  }

  // Phase 2: Cloud env keys (sync)
  const envProviders = scanEnvKeys();
  for (const p of envProviders) {
    if (!providers.some(existing => existing.name === p.name && existing.source === p.source)) {
      providers.push(p);
    }
  }

  // Phase 3: Own accounts (sync)
  const ownProviders = scanOwnAccounts();
  for (const p of ownProviders) {
    if (!providers.some(existing => existing.name === p.name && existing.source === p.source)) {
      providers.push(p);
    }
  }

  // Phase 4: Local endpoints (async — probes network)
  const localProviders = await scanLocalEndpoints();
  for (const p of localProviders) {
    if (!providers.some(existing => existing.name === p.name)) {
      providers.push(p);
    }
  }

  // Build summary
  const installedTools = tools.filter(t => t.installed);
  const readiness = summarizeProviderReadiness(providers);

  const summary = [
    `Scanned ${tools.length} tools, found ${installedTools.length} installed.`,
    `${readiness.configuredKeys} configured keys, ` +
      `${readiness.discoveredProviders} providers discovered, ` +
      `${readiness.readyProviders} ready, ` +
      `${readiness.manualSetupBlockers} manual setup blockers.`,
  ].join(' ');

  log.info(summary);

  return { tools, providers, summary };
}

/**
 * Quick: does the user have at least one usable provider?
 */
export async function hasAnyProvider(): Promise<boolean> {
  const report = await discoverAll();
  return report.providers.some(p => describeProviderReadiness(p).ready);
}

/**
 * Onboarding report — human-readable discovery output.
 */
export async function printOnboardingReport(): Promise<string> {
  const { tools, providers, summary } = await discoverAll();
  const lines: string[] = [
    '',
    '══ los Onboarding Scan ══',
    '',
    summary,
    '',
  ];

  // Tools found
  lines.push('── Installed Tools ──');
  for (const t of tools) {
    if (t.installed) {
      const age = t.lastUsed ? ` (last used: ${t.lastUsed})` : '';
      const ver = t.version ? ` [${t.version}]` : '';
      lines.push(`  ✅ ${t.name.padEnd(12)} ${t.configPath}${ver}${age}`);
    } else {
      lines.push(`  ❌ ${t.name.padEnd(12)} not found`);
    }
  }

  // Providers found
  lines.push('');
  lines.push('── Discovered Providers ──');
  const readiness = providers.map(p => ({
    provider: p,
    readiness: describeProviderReadiness(p),
  }));
  const readyProviders = readiness.filter(p => p.readiness.ready);
  const needsSetup = readiness.filter(p => p.readiness.manualSetupRequired);

  if (readiness.length > 0) {
    lines.push('');
    lines.push('  Readiness:');
    for (const { provider: p, readiness: r } of readiness) {
      const model = p.defaultModel ? ` [${p.defaultModel}]` : '';
      const status = r.ready ? '✓' : '⚠';
      const blocker = r.blocker ? ` ${r.blocker}` : '';
      lines.push(
        `    ${status} ${p.name.padEnd(14)} ← ${p.source}${model} ` +
        `configured_key=${r.configuredKey ? 'yes' : 'no'} ` +
        `discovered=${r.discovered ? 'yes' : 'no'} ` +
        `ready=${r.ready ? 'yes' : 'no'}${blocker}`,
      );
    }
  }

  if (needsSetup.length > 0) {
    lines.push('');
    lines.push('  Manual setup blockers:');
    for (const { provider: p, readiness: r } of needsSetup) {
      const note = p.note ? ` — ${p.note}` : '';
      lines.push(`    ${r.blocker} Source: ${p.source}${note}`);
    }
  }

  if (readyProviders.length === 0) {
    lines.push('');
    lines.push('  No providers ready. To get started:');
    lines.push('    • Set DEEPSEEK_API_KEY in your environment or .env file');
    lines.push('    • Or store keys in ~/.los/accounts/<name>.json');
    lines.push('    • Or install Ollama for local models: brew install ollama');
  }

  lines.push('');
  return lines.join('\n');
}
