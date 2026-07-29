/**
 * @los/agent/tools/builtin-mcp-servers.test — Built-in MCP server auto-start tests.
 *
 * Tests:
 *   1. isBrowserMCPServerConfig — external browser server detection
 *   2. Browser toolset prefix matching — playwright/puppeteer tool names
 *   3. createBrowserMCPServer — config generation + env safety
 *   4. resolveBuiltinMCPConfigs — pluggable registry resolution
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  isBrowserMCPServerConfig,
  createBrowserMCPServer,
  resolveBuiltinMCPConfigs,
  buildSafeMCPEnv,
} from './builtin-mcp-servers.js';
import type { BuiltinMCPServer } from './builtin-mcp-servers.js';
import type { MCPServerConfig } from '../external/mcp-client.js';

// ── isBrowserMCPServerConfig ────────────────────────────

describe('isBrowserMCPServerConfig', () => {
  it('detects playwright servers', () => {
    assert.equal(isBrowserMCPServerConfig(makeConfig('npx', ['-y', '@executeautomation/playwright-mcp-server'])), true);
    assert.equal(isBrowserMCPServerConfig(makeConfig('playwright-mcp-server')), true);
    assert.equal(isBrowserMCPServerConfig(makeConfig('npx', ['@anthropic/mcp-playwright'])), true);
  });

  it('detects puppeteer servers', () => {
    assert.equal(isBrowserMCPServerConfig(makeConfig('npx', ['@modelcontextprotocol/server-puppeteer'])), true);
    assert.equal(isBrowserMCPServerConfig(makeConfig('puppeteer-server')), true);
  });

  it('detects browser-related servers', () => {
    assert.equal(isBrowserMCPServerConfig(makeConfig('npx', ['@browserbasehq/mcp'])), true);
    assert.equal(isBrowserMCPServerConfig(makeConfig('browser-use', ['--mcp'])), true);
  });

  it('detects selenium servers', () => {
    assert.equal(isBrowserMCPServerConfig(makeConfig('selenium-standalone')), true);
  });

  it('does not detect non-browser servers', () => {
    assert.equal(isBrowserMCPServerConfig(makeConfig('npx', ['@anthropic/mcp-filesystem'])), false);
    assert.equal(isBrowserMCPServerConfig(makeConfig('npx', ['@modelcontextprotocol/server-memory'])), false);
    assert.equal(isBrowserMCPServerConfig(makeConfig('node', ['server.js'])), false);
  });

  it('handles empty config', () => {
    assert.equal(isBrowserMCPServerConfig(makeConfig('', [])), false);
  });
});

// ── Browser toolset prefix matching ─────────────────────

function isToolEnabledByBrowserToolset(name: string, enabled: Set<string>): boolean {
  if (enabled.has(name)) return true;
  const prefix = name.split('_')[0]!;
  return prefix !== name && enabled.has(prefix);
}

describe('browser toolset prefix matching', () => {
  const browserToolset = new Set(['playwright', 'puppeteer']);

  it('matches playwright_* tools', () => {
    for (const tool of ['playwright_navigate', 'playwright_screenshot', 'playwright_click',
      'playwright_fill', 'playwright_evaluate', 'playwright_console_logs',
      'playwright_drag', 'playwright_press_key', 'playwright_save_as_pdf']) {
      assert.equal(isToolEnabledByBrowserToolset(tool, browserToolset), true, tool);
    }
  });

  it('matches puppeteer_* tools (backward compat)', () => {
    for (const tool of ['puppeteer_navigate', 'puppeteer_screenshot', 'puppeteer_evaluate']) {
      assert.equal(isToolEnabledByBrowserToolset(tool, browserToolset), true, tool);
    }
  });

  it('does not match unrelated tools', () => {
    assert.equal(isToolEnabledByBrowserToolset('read_file', browserToolset), false);
    assert.equal(isToolEnabledByBrowserToolset('web_search', browserToolset), false);
  });

  it('does not match similar-but-different prefixes', () => {
    assert.equal(isToolEnabledByBrowserToolset('play_sound', browserToolset), false);
    assert.equal(isToolEnabledByBrowserToolset('puppet_show', browserToolset), false);
  });
});

// ── createBrowserMCPServer ──────────────────────────────

describe('createBrowserMCPServer', () => {
  it('generates correct MCPServerConfig with version pin', () => {
    const server = createBrowserMCPServer();
    const config = server.createConfig();

    assert.equal(config.command, 'npx');
    assert.equal(config.transport, 'stdio');
    assert.equal(config.serverId, 'builtin-browser');
    assert.ok(config.args!.join(' ').includes('@executeautomation/playwright-mcp-server@1.1.1'),
      `expected version-pinned package, got: ${config.args!.join(' ')}`);
    assert.equal(config.env!.PLAYWRIGHT_HEADLESS, 'true');
    assert.equal(config.env!.PLAYWRIGHT_BROWSER, 'chromium');
  });

  it('respects headless=false config', () => {
    const server = createBrowserMCPServer({ headless: false });
    const config = server.createConfig();
    assert.equal(config.env!.PLAYWRIGHT_HEADLESS, 'false');
  });

  it('respects engine=firefox config', () => {
    const server = createBrowserMCPServer({ engine: 'firefox' });
    const config = server.createConfig();
    assert.equal(config.env!.PLAYWRIGHT_BROWSER, 'firefox');
  });

  it('isEnabled=false when autoStart is disabled', () => {
    const server = createBrowserMCPServer({ autoStart: false });
    assert.equal(server.isEnabled(), false);
  });

  it('shouldAutoStart=false when external browser server exists', () => {
    const server = createBrowserMCPServer();
    const external = [makeConfig('npx', ['playwright-mcp-server'])];
    assert.equal(server.shouldAutoStart(external), false);
  });

  it('shouldAutoStart=true when no external browser server', () => {
    const server = createBrowserMCPServer();
    const external = [makeConfig('npx', ['@anthropic/mcp-filesystem'])];
    assert.equal(server.shouldAutoStart(external), true);
  });
});

// ── resolveBuiltinMCPConfigs ────────────────────────────

describe('resolveBuiltinMCPConfigs', () => {
  it('returns empty when no servers are eligible', () => {
    // browser autoStart disabled → no configs
    // (but the default is enabled, so this test relies on
    //  the toolset NOT including 'browser' or 'all')
    const configs = resolveBuiltinMCPConfigs([]);
    // In test environment without LOS_ENABLED_TOOLSETS=browser set,
    // the browser server's isEnabled() should return false.
    assert.equal(configs.length, 0);
  });

  it('does not duplicate when external browser server is registered', () => {
    const external = [makeConfig('npx', ['playwright-mcp-server'])];
    const configs = resolveBuiltinMCPConfigs(external);
    assert.equal(configs.length, 0, 'should skip auto-start when external browser server exists');
  });

  it('supports multiple future built-in servers', () => {
    // Verify the interface is extensible — any BuiltinMCPServer is acceptable
    const dummy: BuiltinMCPServer = {
      id: 'dummy',
      displayName: 'Dummy',
      isEnabled: () => false,
      shouldAutoStart: () => false,
      createConfig: () => ({ command: 'echo', args: [], transport: 'stdio' }),
    };
    assert.equal(dummy.id, 'dummy');
    assert.equal(dummy.isEnabled(), false);
  });
});

// ── buildSafeMCPEnv ─────────────────────────────────────

describe('buildSafeMCPEnv', () => {
  it('includes whitelisted keys', () => {
    const env = buildSafeMCPEnv();
    assert.ok('PATH' in env, 'PATH should be in safe env');
    assert.ok('HOME' in env, 'HOME should be in safe env');
  });

  it('does NOT leak API keys', () => {
    const env = buildSafeMCPEnv();
    assert.equal('DEEPSEEK_API_KEY' in env, false, 'API keys must not leak');
    assert.equal('OPENAI_API_KEY' in env, false);
    assert.equal('ANTHROPIC_API_KEY' in env, false);
    assert.equal('DATABASE_URL' in env, false);
    assert.equal('LOS_AUTH_TOKEN' in env, false);
  });
});

// ── Helpers ─────────────────────────────────────────────

function makeConfig(command: string, args: string[] = []): MCPServerConfig {
  return { command, args, transport: 'stdio' };
}
