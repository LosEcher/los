/**
 * @los/infra/config — Multi-source configuration with auto-discovery.
 *
 * Discovery chain (highest to lowest priority):
 *   1. CLI flags / process.env overrides
 *   2. .env file in working directory
 *   3. ~/.los/config.yaml (user profile)
 *   4. /etc/los/config.yaml (system-wide)
 *   5. Built-in defaults
 *
 * Inspired by: cc-switch's ~/.codex/accounts/ pattern,
 *              cliproxy's profile-based multi-account setup.
 */

import { z } from 'zod';
import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import YAML from 'yaml';
import { getLogger } from './logger.js';
import { discoverAll, type DiscoveredProvider } from './discovery.js';

const log = getLogger('config');

// ── Schema ──────────────────────────────────────────────

export const ConfigSchema = z.object({
  // Database
  databaseUrl: z.string()
    .refine(v => v.startsWith('postgres://') || v.startsWith('postgresql://'), 'DATABASE_URL must use postgres:// or postgresql://')
    .default('postgres://los:los@127.0.0.1:5432/los'),

  // Server
  server: z.object({
    port: z.coerce.number().default(8080),
    host: z.string().default('127.0.0.1'),
  }),

  // Agent
  agent: z.object({
    defaultProvider: z.string().default('deepseek'),
    defaultModel: z.string().default('deepseek-v4-flash'),
    maxLoops: z.coerce.number().default(20),
    sandboxMode: z.enum(['readonly', 'workspace-write', 'sandbox']).default('workspace-write'),
    systemPrompt: z.string().optional(),
  }),

  // Providers (auto-discovered, can be overridden)
  providers: z.record(z.string(), z.object({
    apiKey: z.string().optional(),
    baseUrl: z.string().optional(),
    model: z.string().optional(),
    enabled: z.coerce.boolean().default(true),
    source: z.string().optional(),
    weight: z.coerce.number().default(100),
  })).default({}),

  // Memory
  memory: z.object({
    ftsEnabled: z.coerce.boolean().default(true),
    maxObservations: z.coerce.number().default(10000),
  }),

  // Executor
  executor: z.object({
    enabled: z.coerce.boolean().default(false),
    agentKey: z.string().optional(),
    nodeId: z.string().optional(),
    nodeUrl: z.string().optional(),
    meshNodes: z.array(z.string()).default([]),
  }),

  // Active profile name
  profile: z.string().default('default'),
});

export type Config = z.infer<typeof ConfigSchema>;

// ── Discovery ───────────────────────────────────────────

const ENV_MAP: [string, string][] = [
  ['DATABASE_URL', 'databaseUrl'],
  ['SERVER_PORT', 'server.port'],
  ['SERVER_HOST', 'server.host'],
  ['AGENT_DEFAULT_PROVIDER', 'agent.defaultProvider'],
  ['AGENT_DEFAULT_MODEL', 'agent.defaultModel'],
  ['AGENT_MAX_LOOPS', 'agent.maxLoops'],
  ['AGENT_SANDBOX_MODE', 'agent.sandboxMode'],
  ['AGENT_SYSTEM_PROMPT', 'agent.systemPrompt'],
  ['MEMORY_FTS_ENABLED', 'memory.ftsEnabled'],
  ['EXECUTOR_ENABLED', 'executor.enabled'],
  ['EXECUTOR_AGENT_KEY', 'executor.agentKey'],
  ['EXECUTOR_NODE_ID', 'executor.nodeId'],
  ['EXECUTOR_NODE_URL', 'executor.nodeUrl'],
  ['EXECUTOR_MESH_NODES', 'executor.meshNodes'],
  ['LOS_PROFILE', 'profile'],
];

function loadEnvFile(cwd: string): Record<string, string> {
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
      // Strip quotes
      if ((value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      result[key] = value;
    }
  } catch { /* ignore */ }
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
  try {
    const content = readFileSync(path, 'utf-8');
    return YAML.parse(content) ?? {};
  } catch (e: any) {
    log.warn(`Failed to parse ${path}: ${e.message}`);
    return null;
  }
}

function loadUserConfig(): Record<string, unknown> | null {
  const paths = [
    join(homedir(), '.los', 'config.yaml'),
    join(homedir(), '.los', 'config.yml'),
  ];
  for (const p of paths) {
    const cfg = loadYamlConfig(p);
    if (cfg) return cfg;
  }
  return null;
}

function loadSystemConfig(): Record<string, unknown> | null {
  const paths = [
    '/etc/los/config.yaml',
    '/etc/los/config.yml',
  ];
  for (const p of paths) {
    const cfg = loadYamlConfig(p);
    if (cfg) return cfg;
  }
  return null;
}

function setNested(obj: any, path: string, value: unknown): void {
  const parts = path.split('.');
  let current = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (!(parts[i] in current)) current[parts[i]] = {};
    current = current[parts[i]];
  }
  current[parts[parts.length - 1]] = value;
}

function flattenEnv(env: Record<string, string>, sourceLabel = 'env'): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [envKey, configPath] of ENV_MAP) {
    const val = env[envKey];
    if (val !== undefined && val !== '') {
      // Special handling: meshNodes is comma-separated
      if (configPath === 'executor.meshNodes') {
        setNested(result, configPath, val.split(',').map(s => s.trim()).filter(Boolean));
      } else {
        setNested(result, configPath, val);
      }
    }
  }

  // Auto-detect provider API keys from env
  for (const [key, value] of Object.entries(env)) {
    const match = key.match(/^([A-Z_]+)_API_KEY$/);
    if (match && value) {
      const provider = match[1].toLowerCase();
      if (!result.providers) result.providers = {};
      (result.providers as any)[provider] = {
        apiKey: value,
        enabled: true,
        source: `${sourceLabel}:${key}`,
      };
    }
  }

  return result;
}

// ── Provider Discovery ──────────────────────────────────

async function mergeDiscoveredProviders(
  config: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const { providers: discovered } = await discoverAll();

  if (!config.providers) config.providers = {};
  const providers = config.providers as Record<string, any>;

  for (const dp of discovered) {
    if (!providers[dp.name]) {
      providers[dp.name] = {};
    }
    const p = providers[dp.name];

    // Only fill in if not explicitly set by user
    if (!p.apiKey && dp.apiKey) p.apiKey = dp.apiKey;
    if (!p.baseUrl && dp.baseUrl) p.baseUrl = dp.baseUrl;
    if (!p.model && dp.defaultModel) p.model = dp.defaultModel;
    if (p.enabled === undefined) p.enabled = dp.available;
    if (!p.source && dp.source) p.source = dp.source;
  }

  return config;
}

// ── Main Loader ─────────────────────────────────────────

let _config: Config | null = null;

export async function loadConfig(opts?: {
  cwd?: string;
  cliOverrides?: Record<string, unknown>;
}): Promise<Config> {
  const cwd = resolve(opts?.cwd ?? process.cwd());

  // Layer 1: Built-in defaults (ensure all schema keys exist)
  let merged: Record<string, unknown> = {
    server: { port: 8080, host: '127.0.0.1' },
    agent: { defaultProvider: 'deepseek', defaultModel: 'deepseek-v4-flash', maxLoops: 20, sandboxMode: 'workspace-write' },
    memory: { ftsEnabled: true, maxObservations: 10000 },
    executor: { enabled: false, meshNodes: [] },
    providers: {},
    databaseUrl: 'postgres://los:los@127.0.0.1:5432/los',
    profile: 'default',
  };

  // Layer 2: System config (/etc/los/config.yaml)
  const sys = loadSystemConfig();
  if (sys) {
    const profile = (sys as any).profile ?? 'default';
    merged = (sys as any).profiles?.[profile] ?? sys;
    log.debug(`Loaded system config: /etc/los/config.yaml (profile: ${profile})`);
  }

  // Layer 3: User config (~/.los/config.yaml)
  const user = loadUserConfig();
  if (user) {
    const profile = (user as any).profile ?? (merged as any).profile ?? 'default';
    const profileCfg = (user as any).profiles?.[profile] ?? user;
    merged = deepMerge(merged, profileCfg);
    log.debug(`Loaded user config: ~/.los/config.yaml (profile: ${profile})`);
  }

  // Layer 4: .env file
  const envFile = loadEnvFile(cwd);
  if (Object.keys(envFile).length > 0) {
    merged = deepMerge(merged, flattenEnv(envFile, '.env'));
    log.debug(`Loaded .env from ${cwd}`);
  }

  // Layer 5: Process environment
  const procEnv: Record<string, string> = {};
  for (const [key] of ENV_MAP) {
    if (process.env[key] !== undefined) procEnv[key] = process.env[key]!;
  }
  // Also grab all *_API_KEY from process.env
  for (const [key, value] of Object.entries(process.env)) {
    if (key.endsWith('_API_KEY') && value) procEnv[key] = value;
  }
  if (Object.keys(procEnv).length > 0) {
    merged = deepMerge(merged, flattenEnv(procEnv, 'env'));
    log.debug('Applied process environment variables');
  }

  // Layer 6: Provider auto-discovery
  merged = await mergeDiscoveredProviders(merged);

  // Layer 7: CLI overrides (highest priority)
  if (opts?.cliOverrides) {
    merged = deepMerge(merged, opts.cliOverrides);
  }

  // Validate
  const result = ConfigSchema.safeParse(merged);
  if (!result.success) {
    console.error('Configuration error:');
    for (const issue of result.error.issues) {
      console.error(`  - ${issue.path.join('.')}: ${issue.message}`);
    }
    process.exit(1);
  }

  _config = result.data;

  log.info(`Config loaded — db=PG, ` +
    `provider=${result.data.agent.defaultProvider}, ` +
    `providers_discovered=${Object.keys(result.data.providers).length}`);

  return result.data;
}

export function getConfig(): Config {
  if (!_config) throw new Error('Config not loaded. Call loadConfig() first.');
  return _config;
}

export function setConfig(config: Config): void {
  _config = config;
}

// ── Helpers ─────────────────────────────────────────────

function deepMerge(target: Record<string, unknown>, source: Record<string, unknown>): Record<string, unknown> {
  const result = { ...target };
  for (const [key, val] of Object.entries(source)) {
    if (val && typeof val === 'object' && !Array.isArray(val) &&
        result[key] && typeof result[key] === 'object' && !Array.isArray(result[key])) {
      result[key] = deepMerge(result[key] as Record<string, unknown>, val as Record<string, unknown>);
    } else {
      result[key] = val;
    }
  }
  return result;
}

// ── CLI helpers ─────────────────────────────────────────

export function printConfigDiagnostics(config: Config): string {
  const lines: string[] = [
    '== los Config ==',
    `  Profile:      ${config.profile}`,
    `  Database:     ${config.databaseUrl.replace(/\/\/.*@/, '//***@')}`,
    `  Server:       ${config.server.host}:${config.server.port}`,
    `  Provider:     ${config.agent.defaultProvider} / ${config.agent.defaultModel}`,
    `  Max loops:    ${config.agent.maxLoops}`,
    `  Sandbox:      ${config.agent.sandboxMode}`,
    `  FTS:          ${config.memory.ftsEnabled}`,
    `  Executor:     ${config.executor.enabled ? `enabled (${config.executor.meshNodes.length} nodes)` : 'disabled'}`,
    '',
    '  Providers discovered:',
  ];

  for (const [name, p] of Object.entries(config.providers)) {
    const source = p.source ?? 'manual';
    const hasKey = typeof p.apiKey === 'string' && p.apiKey.length > 0;
    const ready = p.enabled && hasKey;
    const status = ready ? '✓' : '✗';
    const model = p.model ?? '(default)';
    lines.push(
      `    ${status} ${name.padEnd(12)} model=${model.padEnd(20)} ` +
      `configured_key=${hasKey ? 'yes' : 'no'} ready=${ready ? 'yes' : 'no'} source=${source}`,
    );
  }

  return lines.join('\n');
}
