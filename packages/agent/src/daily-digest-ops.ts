/**
 * Daily digest ops sections: fleet resources + provider readiness (D1/D3).
 * Kept separate so daily-digest.ts stays under module-size gates.
 */

import { getConfig, loadConfig } from '@los/infra/config';
import { listExecutorNodes } from './executor-nodes.js';
import { evaluateNamedFleetResources, formatFleetResourceSummary } from './fleet-resources.js';
import { codexAvailable } from './runtime-adapter/codex.js';

export interface DigestOpsSnapshot {
  fleetLines: string[];
  providerLines: string[];
  attention: string[];
}

/**
 * Read-only snapshot for daily highlights — no SSH, no provider network calls.
 * Uses last heartbeat capacity + config key presence.
 */
export async function collectDigestOpsSnapshot(): Promise<DigestOpsSnapshot> {
  // Ensure config singleton is available for provider matrix (CLI / test paths).
  try {
    getConfig();
  } catch {
    await loadConfig();
  }
  const attention: string[] = [];
  let fleetLines: string[] = [];
  try {
    const nodes = await listExecutorNodes(50);
    const resources = evaluateNamedFleetResources(nodes);
    fleetLines = formatFleetResourceSummary(resources).slice(0, 12);
    if (resources.criticalCodes.length > 0) {
      attention.push(`fleet critical: ${resources.criticalCodes.slice(0, 4).join(',')}`);
    } else if (resources.warningCodes.length > 0) {
      attention.push(`fleet warn: ${resources.warningCodes.slice(0, 4).join(',')}`);
    }
  } catch (err) {
    fleetLines = [`fleet snapshot failed: ${err instanceof Error ? err.message : String(err)}`];
    attention.push('fleet snapshot unavailable');
  }

  const providerLines = buildProviderReadinessLines();
  for (const line of providerLines) {
    if (line.includes('not_ready') || line.includes('missing_key')) {
      attention.push(line);
    }
  }

  return { fleetLines, providerLines, attention: attention.slice(0, 8) };
}

function buildProviderReadinessLines(): string[] {
  let config: ReturnType<typeof getConfig>;
  try {
    config = getConfig();
  } catch {
    // Digest may run before getConfig is primed in some CLI paths.
    return ['provider matrix: config not loaded'];
  }
  const providers = (config.providers ?? {}) as Record<string, {
    model?: string;
    baseUrl?: string;
    apiKey?: string;
    enabled?: boolean;
    source?: string;
    apiShape?: string;
    authMode?: string;
  }>;
  const watch = ['deepseek', 'packycode', 'xai', 'deepseek-anthropic'];
  const lines: string[] = [];
  for (const name of watch) {
    const p = providers[name];
    if (!p) {
      lines.push(`provider ${name}: missing`);
      continue;
    }
    const hasKey = Boolean(p.apiKey) || p.authMode === 'oauth';
    const enabled = p.enabled !== false;
    const ready = enabled && hasKey;
    const model = p.model ?? 'n/a';
    const shape = p.apiShape ?? 'default';
    const src = p.source ?? 'unknown';
    lines.push(
      `provider ${name}: ${ready ? 'ready' : (hasKey ? 'disabled' : 'missing_key')} `
      + `model=${model} shape=${shape} src=${src}`,
    );
  }
  lines.push(`runtime codex: ${codexAvailable() ? 'available' : 'missing_cli'}`);
  const defP = config.agent?.defaultProvider ?? 'n/a';
  const defM = config.agent?.defaultModel ?? 'n/a';
  lines.push(`default agent: ${defP}/${defM}`);
  return lines;
}

/** Append ops sections into digest highlight lines. */
export function appendOpsHighlights(
  base: string[],
  ops: DigestOpsSnapshot,
): string[] {
  const out = [...base];
  if (ops.fleetLines.length > 0) {
    out.push(`Fleet: ${ops.fleetLines[0]}`);
    for (const line of ops.fleetLines.slice(1, 5)) out.push(`  ${line}`);
  }
  if (ops.providerLines.length > 0) {
    out.push('Providers:');
    for (const line of ops.providerLines.slice(0, 6)) out.push(`  ${line}`);
  }
  if (ops.attention.length > 0) {
    out.push(`Ops attention: ${ops.attention.join(' | ')}`);
  }
  return out;
}
