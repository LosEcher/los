import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { getConfig } from '../config.js';
import { getLogger } from '../logger.js';
import type { CodexRouteConfig, DiscoveredProvider, DiscoveredTool } from './types.js';
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

        // Map env key to provider name
        const keyMap: Record<string, { name: string; baseUrl?: string; model?: string }> = {
          'OPENROUTER_API_KEY': { name: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1', model: 'openai/gpt-4o' },
          'DEEPSEEK_API_KEY': { name: 'deepseek', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-v4-flash' },
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

export function scanEnvKeys(): DiscoveredProvider[] {
  const providers: DiscoveredProvider[] = [];

  const keyMap: Record<string, { name: string; baseUrl: string; model: string }> = {
    'DEEPSEEK_API_KEY':     { name: 'deepseek',   baseUrl: 'https://api.deepseek.com/v1',           model: 'deepseek-v4-flash' },
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
    endpoints = [
      { name: 'ollama',   url: 'http://127.0.0.1:11434/api/tags', baseUrl: 'http://127.0.0.1:11434/v1', model: 'llama3.1' },
      { name: 'lmstudio', url: 'http://127.0.0.1:1234/v1/models', baseUrl: 'http://127.0.0.1:1234/v1',   model: '(auto)' },
      { name: 'vllm',     url: 'http://127.0.0.1:8000/v1/models', baseUrl: 'http://127.0.0.1:8000/v1',     model: '(auto)' },
      { name: 'llamacpp', url: 'http://127.0.0.1:8081/v1/models', baseUrl: 'http://127.0.0.1:8081/v1',     model: '(auto)' },
      { name: 'localai',  url: 'http://127.0.0.1:8082/v1/models', baseUrl: 'http://127.0.0.1:8082/v1',     model: '(auto)' },
    ];
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

// ── Main Export ─────────────────────────────────────────

