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

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { getConfig } from './config.js';
import { getLogger } from './logger.js';
import type { CodexRouteConfig, DiscoveredProvider, DiscoveredTool, DiscoveryReport } from './discovery/types.js';
import { fileAge, readString } from './discovery/helpers.js';
import {
  describeProviderReadiness,
  summarizeProviderReadiness,
} from './discovery/readiness.js';
import {
  ccSwitchProviderFromRow,
  parseCcSwitchRowsWithCli,
  parseCodexRouteConfig,
} from './discovery/provider-parsers.js';
import {
  scanCodex,
  scanClaude,
  scanOpenCode,
  scanCcSwitch,
  scanHermes,
  scanEnvKeys,
  scanLocalEndpoints,
  scanOwnAccounts,
  scanXaiOAuth,
} from './discovery/scanners.js';

const require = createRequire(import.meta.url);

const log = getLogger('discovery');

export {
  describeProviderReadiness,
  providerApiKeyEnv,
  summarizeProviderReadiness,
} from './discovery/readiness.js';
export {
  ccSwitchProviderFromRow,
  parseCodexRouteConfig,
} from './discovery/provider-parsers.js';
export type {
  DiscoveredProvider,
  DiscoveredTool,
  DiscoveryReport,
  ProviderPromotionState,
  ProviderReadiness,
  ProviderReadinessSummary,
} from './discovery/types.js';

// ── Tool Scanners ───────────────────────────────────────

// ── 1. Codex CLI ────────────────────────────────────────

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

  // Phase 3.5: xAI OAuth tokens (sync — reads local auth stores)
  const xaiOAuthProviders = scanXaiOAuth();
  for (const p of xaiOAuthProviders) {
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

