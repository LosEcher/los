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

export interface DiscoveryReport {
  tools: DiscoveredTool[];
  providers: DiscoveredProvider[];
  summary: string;
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

// ── 1. Codex CLI ────────────────────────────────────────

function scanCodex(): { tool: DiscoveredTool; providers: DiscoveredProvider[] } {
  const home = join(homedir(), '.codex');
  const authPath = join(home, 'auth.json');
  const configPath = join(home, 'config.toml');
  const providers: DiscoveredProvider[] = [];

  const installed = existsSync(home);
  const tool: DiscoveredTool = {
    name: 'codex',
    installed,
    configPath: home,
    lastUsed: fileAge(authPath) ?? fileAge(configPath),
  };

  if (!installed) return { tool, providers };

  // Parse auth.json
  if (existsSync(authPath)) {
    try {
      const auth = JSON.parse(readFileSync(authPath, 'utf-8'));
      tool.version = auth.auth_mode ?? 'unknown';

      if (auth.OPENAI_API_KEY) {
        providers.push({
          name: 'openai',
          apiKey: auth.OPENAI_API_KEY,
          baseUrl: 'https://api.openai.com/v1',
          defaultModel: 'gpt-4o',
          available: true,
          source: 'codex/auth.json',
          sourceTool: 'codex',
          importable: true,
        });
      }

      if (auth.tokens?.access_token) {
        providers.push({
          name: 'openai',
          apiKey: auth.tokens.access_token,
          baseUrl: 'https://api.openai.com/v1',
          defaultModel: 'gpt-4o',
          available: true,
          source: 'codex/auth.json (ChatGPT OAuth)',
          sourceTool: 'codex',
          importable: true,
          note: 'ChatGPT plan OAuth token — may expire',
        });
      }
    } catch { /* corrupt auth.json */ }
  }

  // Parse config.toml for model preferences
  if (existsSync(configPath)) {
    try {
      const toml = readFileSync(configPath, 'utf-8');
      const modelMatch = toml.match(/^model\s*=\s*"(.+)"$/m);
      if (modelMatch && providers.length > 0) {
        providers[0].defaultModel = modelMatch[1];
      }

      const providerMatch = toml.match(/^model_provider\s*=\s*"(.+)"$/m);
      if (providerMatch) {
        // Look up the provider URL in [model_providers] section
        const section = new RegExp(`\\[model_providers\\.${providerMatch[1]}\\]\\n(.*?)(?=\\n\\[|$)`, 's');
        const sectionMatch = toml.match(section);
        if (sectionMatch && providers.length > 0) {
          const urlMatch = sectionMatch[1].match(/^base_url\s*=\s*"(.+)"$/m);
          if (urlMatch) providers[0].baseUrl = urlMatch[1];
        }
      }
    } catch { /* invalid toml */ }
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
  // But we can detect and report them
  if (existsSync(oauthPath)) {
    try {
      const oauth = JSON.parse(readFileSync(oauthPath, 'utf-8'));
      const hasOAuth = !!(oauth.access_token || oauth.oauth_tokens);
      providers.push({
        name: 'anthropic',
        available: false,               // cannot directly use Claude OAuth tokens
        source: 'claude/.claude.json',
        sourceTool: 'claude',
        importable: false,
        note: hasOAuth
          ? 'Claude OAuth detected, but tokens only work with Claude CLI. Set ANTHROPIC_API_KEY to use directly.'
          : 'Claude installed but no exportable API key found. Set ANTHROPIC_API_KEY.',
      });
    } catch { /* corrupt */ }
  }

  // Check for apiKeyHelper in settings
  if (existsSync(settingsPath)) {
    try {
      const settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
      if (settings.apiKeyHelper) {
        providers.push({
          name: 'anthropic',
          available: false,
          source: 'claude/settings.json (apiKeyHelper)',
          sourceTool: 'claude',
          importable: false,
          note: 'Claude uses a custom apiKeyHelper script. Set ANTHROPIC_API_KEY to use directly.',
        });
      }
      if (settings.model) {
        tool.version = settings.model;
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
      try {
        const config = JSON.parse(row.settings_config ?? '{}');
        if (config.api_key || config.apiKey) {
          const key = config.api_key || config.apiKey;
          // Map app_type to provider name
          const providerMap: Record<string, string> = {
            claude: 'anthropic',
            codex: 'openai',
            opencode: config.provider || 'anthropic',
            gemini: 'google',
          };

          providers.push({
            name: providerMap[row.app_type] ?? row.app_type,
            apiKey: key,
            baseUrl: config.base_url || config.baseUrl,
            defaultModel: config.model,
            available: true,
            source: `cc-switch/${row.name}`,
            sourceTool: 'cc-switch',
            importable: true,
            note: row.is_current ? 'Currently active in cc-switch' : undefined,
          });
        }
      } catch { /* skip unparseable configs */ }
    }
    db.close();
    tool.version = `${rows.length} accounts`;
  } catch {
    tool.version = 'SQLite db found (optional parser unavailable)';
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
        const keyMap: Record<string, string> = {
          'OPENROUTER_API_KEY': 'openrouter',
          'DEEPSEEK_API_KEY': 'deepseek',
          'OPENAI_API_KEY': 'openai',
          'ANTHROPIC_API_KEY': 'anthropic',
          'HF_TOKEN': 'huggingface',
          'GROQ_API_KEY': 'groq',
        };

        const name = keyMap[envKey];
        if (name) {
          providers.push({
            name,
            apiKey: value,
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
    'DEEPSEEK_API_KEY':     { name: 'deepseek',   baseUrl: 'https://api.deepseek.com',              model: 'deepseek-chat' },
    'OPENAI_API_KEY':       { name: 'openai',     baseUrl: 'https://api.openai.com/v1',             model: 'gpt-4o' },
    'ANTHROPIC_API_KEY':    { name: 'anthropic',  baseUrl: 'https://api.anthropic.com',              model: 'claude-sonnet-4-20250514' },
    'MINIMAX_API_KEY':      { name: 'minimax',    baseUrl: 'https://api.minimax.chat/v1',            model: 'abab7-chat' },
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
  const importable = providers.filter(p => p.importable && p.available);
  const detectable = providers.filter(p => !p.importable && p.available === false);

  const summary = [
    `Scanned ${tools.length} tools, found ${installedTools.length} installed.`,
    `${importable.length} providers ready to import, ${detectable.length} detected but need manual setup.`,
  ].join(' ');

  log.info(summary);

  return { tools, providers, summary };
}

/**
 * Quick: does the user have at least one usable provider?
 */
export async function hasAnyProvider(): Promise<boolean> {
  const report = await discoverAll();
  return report.providers.some(p => p.importable && p.available);
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
  const importable = providers.filter(p => p.importable && p.available);
  const needsSetup = providers.filter(p => !p.importable);

  if (importable.length > 0) {
    lines.push('');
    lines.push('  Ready to import:');
    for (const p of importable) {
      const model = p.defaultModel ? ` [${p.defaultModel}]` : '';
      lines.push(`    ✓ ${p.name.padEnd(14)} ← ${p.source}${model}`);
    }
  }

  if (needsSetup.length > 0) {
    lines.push('');
    lines.push('  Detected but needs manual setup:');
    for (const p of needsSetup) {
      const note = p.note ? ` — ${p.note}` : '';
      lines.push(`    ⚠ ${p.name.padEnd(14)} ← ${p.source}${note}`);
    }
  }

  if (importable.length === 0) {
    lines.push('');
    lines.push('  No providers ready. To get started:');
    lines.push('    • Set DEEPSEEK_API_KEY in your environment or .env file');
    lines.push('    • Or store keys in ~/.los/accounts/<name>.json');
    lines.push('    • Or install Ollama for local models: brew install ollama');
  }

  lines.push('');
  return lines.join('\n');
}
