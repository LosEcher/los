import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import { createRequire } from 'node:module';
import { getConfig } from '../config.js';
import { getLogger } from '../logger.js';
import {
  listLocalProviderDefaults,
  listProviderDefaults,
  providerDefaultsForApiKeyEnv,
  requireProviderDefaults,
} from '../provider-defaults.js';
import type {
  CodexRouteConfig,
  DiscoveredProvider,
  DiscoveredTool,
  GrokAccountAuthMode,
  GrokAccountCandidate,
  GrokAccountSourceKind,
} from './types.js';
import { fileAge } from './helpers.js';
import {
  ccSwitchProviderFromRow,
  parseCcSwitchRowsWithCli,
  parseCodexRouteConfig,
} from './provider-parsers.js';
import { describeProviderReadiness } from './readiness.js';

const require = createRequire(import.meta.url);
const log = getLogger('discovery');

export function scanCodex(): { tool: DiscoveredTool; providers: DiscoveredProvider[] } {
  const codexDefaults = requireProviderDefaults('codex');
  const home = join(homedir(), '.codex');
  const authPath = join(home, 'auth.json');
  const configPath = join(home, 'config.toml');
  const providers: DiscoveredProvider[] = [];
  let route: CodexRouteConfig = {
    providerName: 'openai',
    baseUrl: codexDefaults.baseUrl,
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
          defaultModel: route.model ?? codexDefaults.defaultModel,
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
          defaultModel: route.model ?? codexDefaults.defaultModel,
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

export function scanClaude(): { tool: DiscoveredTool; providers: DiscoveredProvider[] } {
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

export function scanOpenCode(): { tool: DiscoveredTool; providers: DiscoveredProvider[] } {
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

export function scanCcSwitch(): { tool: DiscoveredTool; providers: DiscoveredProvider[] } {
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

export function scanHermes(): { tool: DiscoveredTool; providers: DiscoveredProvider[] } {
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

        const catalogEntry = providerDefaultsForApiKeyEnv(envKey);
        const mapped = catalogEntry
          ? {
              name: catalogEntry.name,
              baseUrl: catalogEntry.defaults.baseUrl,
              model: catalogEntry.defaults.defaultModel,
            }
          : envKey === 'HF_TOKEN'
            ? { name: 'huggingface' }
            : undefined;
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

export function scanEnvKeys(): DiscoveredProvider[] {
  const providers: DiscoveredProvider[] = [];

  for (const { name, defaults } of listProviderDefaults()) {
    if (!defaults.apiKeyEnv) continue;
    const envKey = defaults.apiKeyEnv;
    const value = process.env[envKey];
    if (value) {
      providers.push({
        name,
        apiKey: value,
        baseUrl: process.env[`${envKey.replace('_API_KEY', '')}_BASE_URL`] ?? defaults.baseUrl,
        defaultModel: process.env[`${envKey.replace('_API_KEY', '')}_MODEL`] ?? defaults.defaultModel,
        available: true,
        source: `env:${envKey}`,
        importable: true,
      });
    }
  }

  return providers;
}

// ── Local Endpoints ─────────────────────────────────────

export async function checkEndpoint(url: string, timeout = 2000): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    return res.ok;
  } catch { return false; }
}

export async function scanLocalEndpoints(): Promise<DiscoveredProvider[]> {
  let endpoints: Array<{ name: string; url: string; baseUrl: string; model: string }>;
  try {
    const config = getConfig();
    endpoints = config.server.localEndpoints.map(ep => ({
      name: ep.name,
      url: ep.checkUrl,
      baseUrl: ep.baseUrl,
      model: ep.defaultModel,
    }));
  } catch {
    // Config not loaded — use built-in defaults
    endpoints = listLocalProviderDefaults().map(entry => ({
      name: entry.name,
      url: entry.checkUrl,
      baseUrl: entry.baseUrl,
      model: entry.defaultModel,
    }));
  }

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

export function scanOwnAccounts(): DiscoveredProvider[] {
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

// ── 6. xAI OAuth tokens (los + Hermes) ──────────────────

export function scanXaiOAuth(): DiscoveredProvider[] {
  const xaiDefaults = requireProviderDefaults('xai');
  const providers: DiscoveredProvider[] = [];

  try {
    // Check los's own auth store
    const losAuthPath = join(homedir(), '.los', 'auth.json');
    if (existsSync(losAuthPath)) {
      const store = JSON.parse(readFileSync(losAuthPath, 'utf-8'));
      const losState = (store?.providers as Record<string, unknown>)?.['xai-oauth'] as Record<string, unknown> | undefined;
      if (losState?.tokens && (losState.tokens as Record<string, unknown>)?.access_token) {
        providers.push({
          name: 'xai',
          baseUrl: xaiDefaults.baseUrl,
          defaultModel: xaiDefaults.defaultModel,
          authMode: 'oauth',
          available: true,
          source: 'los/auth.json (xAI OAuth)',
          importable: true,
          note: 'SuperGrok / Premium+ OAuth token',
        });
      }
    }

    // Fallback: check Hermes auth store
    const hermesAuthPath = join(homedir(), '.hermes', 'auth.json');
    if (existsSync(hermesAuthPath)) {
      const store = JSON.parse(readFileSync(hermesAuthPath, 'utf-8'));
      const hermesState = (store?.providers as Record<string, unknown>)?.['xai-oauth'] as Record<string, unknown> | undefined;
      if (hermesState?.tokens && (hermesState.tokens as Record<string, unknown>)?.access_token) {
        // Don't duplicate if already found from los store
        if (!providers.some(p => p.name === 'xai' && p.source === 'los/auth.json (xAI OAuth)')) {
          providers.push({
            name: 'xai',
            baseUrl: xaiDefaults.baseUrl,
            defaultModel: xaiDefaults.defaultModel,
            authMode: 'oauth',
            available: true,
            source: 'hermes/auth.json (xAI OAuth)',
            sourceTool: 'hermes',
            importable: true,
            note: 'SuperGrok / Premium+ OAuth token (from Hermes)',
          });
        }
      }
    }
  } catch { /* auth store corrupt or unavailable */ }

  return providers;
}

// ── 7. Grok CLI external login ──────────────────────────

type GrokScanOptions = {
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  nowMs?: number;
  cliInstalled?: boolean;
};

export function scanGrokAccount(options: GrokScanOptions = {}): GrokAccountCandidate {
  const env = options.env ?? process.env;
  const homeDir = options.homeDir ?? homedir();
  const nowMs = options.nowMs ?? Date.now();
  const cliInstalled = options.cliInstalled ?? executableOnPath('grok', env.PATH);
  const source = resolveGrokAuthSource(env, homeDir);
  const base = {
    candidateId: 'xai-grok-default' as const,
    provider: 'xai' as const,
    runtimeKind: 'grok' as const,
    cliInstalled,
    sourceKind: source.kind,
  };

  if (!source.raw) {
    return { ...base, available: false, authMode: null, reason: 'grok_auth_not_found' };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(source.raw);
  } catch {
    return { ...base, available: false, authMode: null, reason: 'grok_auth_malformed' };
  }

  const entries = grokAuthEntries(parsed, source.kind === 'inline_env');
  const supported = entries.find(entry => grokAuthMode(entry.auth_mode) !== 'unknown' && hasString(entry.key));
  if (!supported) {
    const mode = grokAuthMode(entries[0]?.auth_mode);
    return {
      ...base,
      available: false,
      authMode: entries.length > 0 ? mode : null,
      reason: entries.length > 0 && mode === 'unknown'
        ? 'grok_auth_mode_unsupported'
        : 'grok_auth_missing_credential',
    };
  }

  const authMode = grokAuthMode(supported.auth_mode);
  if (grokAuthExpired(supported, nowMs)) {
    return { ...base, available: false, authMode, reason: 'grok_auth_expired' };
  }
  if (!cliInstalled) {
    return { ...base, available: false, authMode, reason: 'grok_cli_not_found' };
  }
  return { ...base, available: true, authMode, reason: null };
}

function resolveGrokAuthSource(
  env: NodeJS.ProcessEnv,
  homeDir: string,
): { kind: GrokAccountSourceKind; raw: string | null } {
  if (hasString(env.GROK_AUTH)) return { kind: 'inline_env', raw: env.GROK_AUTH };
  const explicitPath = hasString(env.GROK_AUTH_PATH) ? env.GROK_AUTH_PATH : null;
  const grokHome = hasString(env.GROK_HOME) ? env.GROK_HOME : null;
  const kind: GrokAccountSourceKind = explicitPath
    ? 'explicit_path'
    : grokHome
      ? 'grok_home'
      : 'default_home';
  const path = explicitPath ?? join(grokHome ?? join(homeDir, '.grok'), 'auth.json');
  if (!existsSync(path)) return { kind, raw: null };
  try {
    return { kind, raw: readFileSync(path, 'utf8') };
  } catch {
    return { kind, raw: null };
  }
}

function grokAuthEntries(value: unknown, inline: boolean): Array<Record<string, unknown>> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  const record = value as Record<string, unknown>;
  if (inline && hasString(record.key)) return [record];
  return Object.values(record).filter(
    (entry): entry is Record<string, unknown> => !!entry && typeof entry === 'object' && !Array.isArray(entry),
  );
}

function grokAuthMode(value: unknown): GrokAccountAuthMode {
  if (value === 'oidc') return 'oidc';
  if (value === 'external') return 'external';
  if (value === 'api_key') return 'api_key';
  if (value === 'web_login' || value === 'grok') return 'legacy';
  return 'unknown';
}

function grokAuthExpired(entry: Record<string, unknown>, nowMs: number): boolean {
  if (hasString(entry.expires_at)) {
    const expiresAt = Date.parse(entry.expires_at);
    return Number.isFinite(expiresAt) && expiresAt <= nowMs;
  }
  if (hasString(entry.create_time)) {
    const createdAt = Date.parse(entry.create_time);
    return Number.isFinite(createdAt) && createdAt + 30 * 24 * 60 * 60 * 1000 <= nowMs;
  }
  return false;
}

function executableOnPath(command: string, pathValue: string | undefined): boolean {
  if (!pathValue) return false;
  return pathValue.split(delimiter).some(dir => existsSync(join(dir, command)));
}

function hasString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}
