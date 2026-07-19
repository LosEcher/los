import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Config } from './config.js';
import { resolveProviderDefaults } from './provider-defaults.js';

function discoverProviderKeyEnv(name: string): string {
  const sharedCredentialEnv: Record<string, string> = {
    'deepseek-anthropic': 'DEEPSEEK_API_KEY', packycode: 'OPENAI_API_KEY',
  };
  return resolveProviderDefaults(name)?.apiKeyEnv ?? sharedCredentialEnv[name] ?? `${name.toUpperCase()}_API_KEY`;
}

export function printConfigDiagnostics(config: Config): string {
  const lines: string[] = [
    '== los Config ==', `  Profile:      ${config.profile}`,
    `  Database:     ${config.databaseUrl.replace(/\/\/.*@/, '//***@')}`,
    `  Server:       ${config.server.host}:${config.server.port}`,
    `  CORS origin:  ${Array.isArray(config.server.corsOrigin) ? config.server.corsOrigin.join(', ') : config.server.corsOrigin}`,
    `  Auth:         ${config.auth.enabled ? 'enabled' : 'disabled'}`,
    `  Provider:     ${config.agent.defaultProvider} / ${config.agent.defaultModel}`,
    `  Max loops:    ${config.agent.maxLoops}`, `  Sandbox:      ${config.agent.sandboxMode}`,
    `  FTS:          ${config.memory.ftsEnabled}`,
    `  Executor:     ${config.executor.enabled ? `enabled (${config.executor.meshNodes.length} nodes)` : 'disabled'}`,
    '', '  Providers discovered:',
  ];
  let hasBlockers = false;
  const setupActions: string[] = [];
  for (const [name, p] of Object.entries(config.providers)) {
    const source = p.source ?? 'manual';
    const hasKey = typeof p.apiKey === 'string' && p.apiKey.length > 0;
    const isOAuth = (p as Record<string, unknown>).authMode === 'oauth';
    const ready = p.enabled && (hasKey || isOAuth);
    let tier = '';
    if (!hasKey && !isOAuth) {
      tier = '[blocked]'; hasBlockers = true;
      setupActions.push(`    • ${name}: ${p.apiKey ? 'key present but not importable' : `set ${discoverProviderKeyEnv(name)}`}`);
    } else if (ready) tier = '[advisory]';
    lines.push(`    ${ready ? '✓' : '✗'} ${name.padEnd(12)} model=${(p.model ?? '(default)').padEnd(20)} `
      + `key=${hasKey ? 'yes' : 'no '} ready=${ready ? 'yes' : 'no '} source=${source.padEnd(24)} ${tier}`);
  }
  if (hasBlockers) {
    lines.push('', '  Setup required for blocked providers:', ...setupActions, '',
      '  To set up a provider after adding credentials: los provider promote <name>');
  }
  return lines.join('\n');
}

export function getMigrateDir(config: Config): string {
  const dir = config.migrationsDir;
  if (dir.startsWith('/')) return dir;
  const abs = join(resolve(process.cwd()), dir);
  if (existsSync(abs)) return abs;
  const pkgDir = resolve(fileURLToPath(import.meta.url), '..', '..');
  return join(pkgDir, dir);
}
