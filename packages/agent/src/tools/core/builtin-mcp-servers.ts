/**
 * @los/agent/tools/builtin-mcp-servers — Pluggable built-in MCP server auto-start.
 *
 * Each built-in server declares:
 *   - An id and display name for logging and events
 *   - An isEnabled() check (toolset + config toggle)
 *   - A shouldAutoStart() check (skip if user already registered one)
 *   - A createConfig() factory (MCPServerConfig for MCPToolBridge)
 *
 * Adding a new built-in server is a single registration in BUILTIN_SERVERS below
 * — no changes to registry.ts, toolsets.ts, or the MCP infrastructure.
 *
 * Design constraints:
 *   - No direct process.env access — config is injected via constructor
 *   - Safe child-process env: only whitelisted vars pass to MCP subprocesses
 *   - Version-pinned: each server specifies a default semver range
 */

import { getLogger } from '@los/infra/logger';
import type { MCPServerConfig } from '../external/mcp-client.js';
import { getEnabledToolsets } from '../../toolsets.js';

const log = getLogger('builtin-mcp');

// ── Interface ──────────────────────────────────────────

export interface BuiltinMCPServer {
  /** Stable identifier (used in serverId and event metadata). */
  readonly id: string;
  /** Human-readable name for logs. */
  readonly displayName: string;
  /** Whether this server should be started (toolset enabled + config allows). */
  isEnabled(): boolean;
  /** Whether auto-start is needed or the user already registered an equivalent. */
  shouldAutoStart(existingConfigs: readonly MCPServerConfig[]): boolean;
  /** Build the MCPServerConfig to pass to MCPToolBridge.connect(). */
  createConfig(): MCPServerConfig;
}

// ── Safe environment for MCP subprocesses ────────────────

/**
 * Environment variable names that are safe to forward to MCP subprocesses.
 * Everything else is stripped to prevent leaking secrets (API keys, tokens, etc.).
 */
const MCP_SAFE_ENV_KEYS = new Set([
  'PATH',
  'HOME',
  'USER',
  'TMPDIR',
  'TEMP',
  'TMP',
  'LANG',
  'LC_ALL',
  'NODE_ENV',
  // Playwright-specific (needed by the MCP server)
  'PLAYWRIGHT_BROWSERS_PATH',
  'PLAYWRIGHT_HEADLESS',
  'PLAYWRIGHT_BROWSER',
  'PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD',
  // Proxy (if configured — needed for npx installs)
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
  // npm/npx
  'NPM_CONFIG_REGISTRY',
  'npm_config_registry',
]);

/**
 * Build a safe subset of process.env for MCP subprocesses.
 * Only whitelisted keys are forwarded; all secrets are stripped.
 */
export function buildSafeMCPEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (MCP_SAFE_ENV_KEYS.has(key)) {
      env[key] = value;
    }
  }
  return env;
}

// ── Browser server implementation ───────────────────────

const BROWSER_SERVER_PACKAGE = '@executeautomation/playwright-mcp-server';
/** Pinned version range — upgrade consciously, not automatically via npx -y. */
const BROWSER_SERVER_VERSION = '1.1.1';

export interface BrowserMCPServerConfig {
  /** false disables auto-start entirely, even if browser toolset is enabled. */
  autoStart: boolean;
  /** Run browser headless (default true). */
  headless: boolean;
  /** Browser engine: chromium, firefox, or webkit. */
  engine: 'chromium' | 'firefox' | 'webkit';
}

const DEFAULT_BROWSER_CONFIG: BrowserMCPServerConfig = {
  autoStart: true,
  headless: true,
  engine: 'chromium',
};

export function createBrowserMCPServer(
  config: Partial<BrowserMCPServerConfig> = {},
): BuiltinMCPServer {
  const resolved: BrowserMCPServerConfig = { ...DEFAULT_BROWSER_CONFIG, ...config };

  return {
    id: 'builtin-browser',
    displayName: 'Browser (Playwright)',

    isEnabled(): boolean {
      if (!resolved.autoStart) {
        log.debug('browser auto-start disabled by config (mcp.browser.autoStart=false)');
        return false;
      }
      const toolsets = getEnabledToolsets();
      const enabled = toolsets.includes('browser') || toolsets.includes('all');
      if (!enabled) {
        log.debug('browser toolset not enabled, skipping auto-start');
      }
      return enabled;
    },

    shouldAutoStart(existingConfigs): boolean {
      const hasExternal = existingConfigs.some(c => isBrowserMCPServerConfig(c));
      if (hasExternal) {
        log.info(
          'external browser MCP server already registered, skipping built-in auto-start',
        );
      }
      return !hasExternal;
    },

    createConfig(): MCPServerConfig {
      const pkgSpec = `${BROWSER_SERVER_PACKAGE}@${BROWSER_SERVER_VERSION}`;
      log.info(
        `auto-starting ${this.displayName}: ${pkgSpec} ` +
        `(headless=${resolved.headless}, engine=${resolved.engine})`,
      );
      return {
        command: 'npx',
        args: ['-y', pkgSpec],
        transport: 'stdio',
        env: {
          ...buildSafeMCPEnv(),
          PLAYWRIGHT_HEADLESS: String(resolved.headless),
          PLAYWRIGHT_BROWSER: resolved.engine,
        },
        serverId: this.id,
      };
    },
  };
}

// ── Registry ────────────────────────────────────────────

/**
 * All built-in MCP servers. Add new servers here — they are automatically
 * picked up by resolveBuiltinMCPConfigs() with no other code changes.
 */
const BUILTIN_SERVERS: BuiltinMCPServer[] = [
  createBrowserMCPServer(),
];

/**
 * Resolve which built-in MCP servers should be auto-started.
 * Called by registerBuiltinTools in registry.ts before MCPToolBridge.connect().
 *
 * @param existingConfigs — already-registered MCP server configs (from DB + request)
 * @returns MCPServerConfig[] to merge into the connect list
 */
export function resolveBuiltinMCPConfigs(
  existingConfigs: readonly MCPServerConfig[],
): MCPServerConfig[] {
  const configs: MCPServerConfig[] = [];
  for (const server of BUILTIN_SERVERS) {
    if (!server.isEnabled()) continue;
    if (!server.shouldAutoStart(existingConfigs)) continue;
    try {
      configs.push(server.createConfig());
    } catch (err) {
      log.warn(
        `builtin MCP server "${server.displayName}" config creation failed: ` +
        `${(err as Error)?.message ?? String(err)}`,
      );
    }
  }
  return configs;
}

// ── Detection helper ────────────────────────────────────

/**
 * Check whether an MCP server config likely provides browser automation tools.
 * Used to avoid auto-starting a browser server when the user has already
 * registered their own browser MCP server.
 */
export function isBrowserMCPServerConfig(config: MCPServerConfig): boolean {
  const signals = [config.command ?? '', ...(config.args ?? [])].join(' ');
  const lower = signals.toLowerCase();
  return lower.includes('playwright')
    || lower.includes('puppeteer')
    || lower.includes('browser')
    || lower.includes('selenium');
}
