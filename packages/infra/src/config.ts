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
export { z };
import { resolve } from 'node:path';
import { getLogger } from './logger.js';
import { listLocalProviderDefaults, requireProviderDefaults } from './provider-defaults.js';
import {
  deepMerge, flattenEnv, knownEnvKeys, loadEnvFile, loadSystemConfig, loadUserConfig, mergeDiscoveredProviders,
} from './config-sources.js';
export { printConfigDiagnostics, getMigrateDir } from './config-diagnostics.js';
const log = getLogger('config');

const DEFAULT_AGENT_PROVIDER = 'deepseek';
const DEFAULT_AGENT_MODEL = requireProviderDefaults(DEFAULT_AGENT_PROVIDER).defaultModel;
const DEFAULT_LOCAL_ENDPOINTS = listLocalProviderDefaults();

/**
 * Heuristic to detect node:test runner processes so auth and DB guards
 * default to safe values during integration tests.
 */
function isLikelyTestProcess(): boolean {
  if (process.env.NODE_ENV === 'test') return true;
  if (process.env.LOS_TEST_MODE === '1') return true;
  if (process.env.NODE_TEST_CONTEXT) return true;
  return process.argv.some((arg) => /\.(test|spec)\.[cm]?[jt]s$/.test(arg));
}

// ── Schema ──────────────────────────────────────────────

export const ConfigSchema = z.object({
  databaseUrl: z.string()
    .refine(v => v.startsWith('postgres://') || v.startsWith('postgresql://'), 'DATABASE_URL must use postgres:// or postgresql://')
    .default('postgres://localhost:5432/los'),

  server: z.object({
    version: z.string().trim().min(1).optional(),
    port: z.coerce.number().default(8080),
    host: z.string().default('127.0.0.1'),
    corsOrigin: z.union([z.string(), z.array(z.string())]).default('http://localhost:5173'),
    localEndpoints: z.array(z.object({
      name: z.string(),
      checkUrl: z.string(),
      baseUrl: z.string(),
      defaultModel: z.string(),
    })).default(DEFAULT_LOCAL_ENDPOINTS),
  }),

  auth: z.object({
    enabled: z.coerce.boolean().default(false),
    token: z.string().optional(),
    /** Shared secret for operator access. When set, the x-los-operator-token header
     *  must match this value for operator-level actions. */
    operatorToken: z.string().optional(),
  }),

  integrations: z.object({ feedAnalysis: z.object({
      serviceToken: z.string().optional(), resultReturningEnabled: z.coerce.boolean().default(true),
      maxInlineBytes: z.coerce.number().int().positive().default(1024 * 1024), maxItems: z.coerce.number().int().positive().max(5000).default(500),
      materialHosts: z.array(z.string()).default([]), materialFetchTimeoutMs: z.coerce.number().int().positive().default(10_000),
      executionTimeoutMs: z.coerce.number().int().positive().default(120_000), callbackPollMs: z.coerce.number().int().positive().default(5_000),
      callbackProfiles: z.record(z.string(), z.object({ url: z.string().url(), secret: z.string().min(32),
        timeoutMs: z.coerce.number().int().positive().default(10_000), maxAttempts: z.coerce.number().int().positive().max(20).default(8) })).default({}),
    }).default({}) }).default({}),

  agent: z.object({
    defaultProvider: z.string().default(DEFAULT_AGENT_PROVIDER),
    defaultModel: z.string().default(DEFAULT_AGENT_MODEL),
    maxLoops: z.coerce.number().default(20),
    sandboxMode: z.enum(['readonly', 'workspace-write', 'sandbox']).default('workspace-write'),
    systemPrompt: z.string().optional(),
    identity: z.object({
      /** Agent name used for identity resolution. 'default' uses the built-in los identity. */
      name: z.string().default('default'),
      /** Override identity level. 'none' disables identity injection entirely. */
      level: z.enum(['none', 'minimal', 'standard', 'full']).optional(),
      /** Whether child/spawned agents inherit parent identity (default: false). */
      inheritForChildren: z.coerce.boolean().default(false),
    }).default({}),
  }),

  // Judge model for post-execution goal evaluation (P0-2).
  // Uses a different provider/model from the agent to avoid self-affirmation bias.
  // Falls back to agent.defaultProvider/defaultModel when not configured.
  judge: z.object({
    provider: z.string().optional(),
    model: z.string().optional(),
    /** Custom system prompt for the judge. Falls back to the built-in evaluator prompt. */
    systemPrompt: z.string().optional(),
  }).default({}),

  // Multi-role review (P0): runs multiple review perspectives (spec-compliance,
  // code-quality, etc.) as independent LLM evaluations before the goal self-check.
  // Each role can use its own provider/model and blocking severity threshold.
  // Disabled by default — set REVIEW_ENABLED=true to activate.
  review: z.object({
    enabled: z.coerce.boolean().default(false),
    roles: z.record(z.string(), z.object({
      /** Provider override for this role. Falls back: role → judge → agent default. */
      provider: z.string().optional(),
      /** Model override for this role. Falls back: role → judge → agent default. */
      model: z.string().optional(),
      /** Custom system prompt for this role. Falls back to the built-in lens prompt. */
      systemPrompt: z.string().optional(),
      /** Minimum severity that blocks task completion. Default: 'critical'. */
      blockingSeverity: z.enum(['critical', 'error', 'warn', 'info']).default('critical'),
      /** Whether this role is active. */
      enabled: z.coerce.boolean().default(true),
    })).default({}),
  }).default({}),

  // Providers (auto-discovered, can be overridden)
  providers: z.record(z.string(), z.object({
    apiKey: z.string().optional(),
    baseUrl: z.string().optional(),
    model: z.string().optional(),
    apiShape: z.string().optional(),
    authMode: z.string().optional(),
    enabled: z.coerce.boolean().default(true),
    source: z.string().optional(),
    weight: z.coerce.number().default(100),
  })).default({}),

  // Memory
  memory: z.object({
    ftsEnabled: z.coerce.boolean().default(true),
    maxObservations: z.coerce.number().default(10000),
    /**
     * Default for POST /chat when body.persistMemory is omitted.
     * true → write episodic observations after successful chat (ADR 0020 input path).
     * OpenAI-compat route intentionally stays false regardless of this default.
     */
    persistChatDefault: z.coerce.boolean().default(true),
    /** Enable agent self-reflection recording. When true, agents persist insights
     *  about their own behavior (strengths, weaknesses, patterns) as observations
     *  with observerType: 'agent_self'. Default: false (opt-in). */
    selfReflectionEnabled: z.coerce.boolean().default(false),
    /** Code graph integration via codebase-memory-mcp (CBM).
     *  All features default off — enable progressively after validation. */
    codeGraph: z.object({
      /** Master switch. When false, no CBM calls are made. */
      enabled: z.coerce.boolean().default(false),
      /** Shadow mode: query CBM but do not inject results into prompts or observations.
       *  Used for measurement and validation. Requires enabled=true. */
      shadowMode: z.coerce.boolean().default(false),
      /** Inject caller/callee context into the system prompt before agent execution.
       *  Requires enabled=true. Phase 2 — enable after shadow mode validation. */
      injectArchitecture: z.coerce.boolean().default(false),
      /** Path to the CBM binary. Default: 'codebase-memory-mcp' (resolved from PATH). */
      cbmCommand: z.string().default('codebase-memory-mcp'),
      /** Extra arguments passed to CBM on every invocation. */
      cbmArgs: z.array(z.string()).default([]),
      /** Maximum tokens for injected code structure context. */
      maxPromptTokens: z.coerce.number().default(400),
    }).default({}),
  }),

  // Executor
  executor: z.object({
    enabled: z.coerce.boolean().default(false),
    version: z.string().trim().min(1).optional(),
    agentKey: z.string().optional(),
    nodeId: z.string().optional(),
    nodeUrl: z.string().optional(),
    nodeKind: z.string().optional(),
    host: z.string().default('127.0.0.1'),
    port: z.coerce.number().int().positive().default(8090),
    /** Time allowed for active executor tasks to finish after SIGTERM before they are aborted. */
    shutdownGraceMs: z.coerce.number().int().min(1_000).max(600_000).default(120_000),
    /** Gateway URL the executor heartbeats to. When unset, executor heartbeats directly to the database. */
    gatewayUrl: z.string().optional(),
    /** Root directory for executor artifact storage. Defaults to .los-runtime/executor-artifacts/<nodeId>. */
    artifactRoot: z.string().optional(),
    connectModes: z.array(z.string()).default([]),
    meshNodes: z.array(z.string()).default([]),
  }),

  // Active profile name
  profile: z.string().default('default'),

  // Project
  defaultProjectId: z.string().default('los'),

  // Migration directory (relative to workspace root, or absolute)
  migrationsDir: z.string().default('packages/infra/migrations'),
});

export type Config = z.infer<typeof ConfigSchema>;

// ── Main Loader ─────────────────────────────────────────

let _config: Config | null = null;

export async function loadConfig(opts?: {
  cwd?: string;
  cliOverrides?: Record<string, unknown>;
}): Promise<Config> {
  const cwd = resolve(opts?.cwd ?? process.cwd());

  // Layer 1: Built-in defaults (ensure all schema keys exist)
  let merged: Record<string, unknown> = {
    server: { port: 8080, host: '127.0.0.1', corsOrigin: 'http://localhost:5173', localEndpoints: DEFAULT_LOCAL_ENDPOINTS },
    auth: { enabled: false },
    integrations: { feedAnalysis: {} },
    agent: { defaultProvider: DEFAULT_AGENT_PROVIDER, defaultModel: DEFAULT_AGENT_MODEL, maxLoops: 20, sandboxMode: 'workspace-write', identity: { name: 'default', inheritForChildren: false } },
    memory: { ftsEnabled: true, maxObservations: 10000, persistChatDefault: true, selfReflectionEnabled: false, codeGraph: { enabled: false, shadowMode: false, injectArchitecture: false, cbmCommand: 'codebase-memory-mcp', cbmArgs: [], maxPromptTokens: 400 } },
    executor: { enabled: false, nodeKind: 'executor', connectModes: [], meshNodes: [] },
    providers: {},
    databaseUrl: 'postgres://localhost:5432/los',
    profile: 'default',
    defaultProjectId: 'los',
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
  for (const key of knownEnvKeys()) {
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

  // Tests disable auth by default to avoid 401 on inject() calls.
  // Set LOS_FORCE_AUTH_IN_TEST=1 to override when auth must be tested.
  if (isLikelyTestProcess() && _config.auth.enabled && process.env.LOS_FORCE_AUTH_IN_TEST !== '1') {
    _config = { ..._config, auth: { ..._config.auth, enabled: false } };
    log.debug('Auth disabled for test process (set LOS_FORCE_AUTH_IN_TEST=1 to override)');
  }

  log.info(`Config loaded — db=PG, ` +
    `provider=${_config.agent.defaultProvider}, ` +
    `providers_discovered=${Object.keys(_config.providers).length}`);

  return _config;
}

export function getConfig(): Config {
  if (!_config) throw new Error('Config not loaded. Call loadConfig() first.');
  return _config;
}

export function setConfig(config: Config): void {
  _config = config;
}
