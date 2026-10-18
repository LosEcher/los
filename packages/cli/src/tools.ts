import { createToolRegistry, registerBuiltinTools, type ToolCapability } from '@los/agent/tools';
import { resolveClientPath } from './client-path.js';

/**
 * `los tools` — static capability/scope inventory.
 *
 * The point is not to grep source. It builds the same registry the agent uses
 * (`registerBuiltinTools` with `skipMcp`) and reports the declarations that
 * would be consulted at runtime. This is the missing summary behind
 * `LOS_TOOL_SCOPE_ENFORCEMENT=block`: without a denominator and a list of
 * "declared empty on purpose" tools, 0 mismatch events are not evidence.
 */

const CONTEXT_IDS = ['tenantId', 'projectId', 'runSpecId', 'sessionId', 'taskRunId'] as const;

type Finding = {
  level: 'error' | 'warn';
  tool: string;
  code: string;
  message: string;
};

export async function toolsCommand(_globalArgs: string[], argv: string[]): Promise<void> {
  const parsed = parseArgs(argv);
  if (parsed.help) {
    printToolsHelp();
    return;
  }

  const registry = createToolRegistry();
  const workspaceRoot = parsed.workspace ? resolveClientPath(parsed.workspace) : process.cwd();
  await registerBuiltinTools(registry, { workspaceRoot, skipMcp: true });

  const capabilities = registry.getCapabilities().sort((a, b) => a.name.localeCompare(b.name));
  const definitions = new Map(
    registry.getDefinitions().map(def => [def.function?.name ?? '', def]),
  );

  const findings: Finding[] = [];
  for (const capability of capabilities) {
    const properties = definitionProperties(definitions.get(capability.name));
    const contextProperties = CONTEXT_IDS.filter(id => id in properties);

    for (const scopeId of capability.scope) {
      if (!(scopeId in properties)) {
        findings.push({
          level: 'error',
          tool: capability.name,
          code: 'scope_not_in_schema',
          message: `scope "${scopeId}" is not in parameters.properties`,
        });
      }
    }
    if (capability.scope.length === 0 && contextProperties.length > 0) {
      findings.push({
        level: 'warn',
        tool: capability.name,
        code: 'context_arg_without_scope',
        message: `schema exposes ${contextProperties.join(',')} but scope=[]`,
      });
    }
    if (capability.sideEffect && capability.permissions.length === 0) {
      findings.push({
        level: 'warn',
        tool: capability.name,
        code: 'side_effect_without_permission',
        message: 'sideEffect=true but permissions=[]',
      });
    }
  }

  const summary = {
    total: capabilities.length,
    scoped: capabilities.filter(capability => capability.scope.length > 0).length,
    empty: capabilities.filter(capability => capability.scope.length === 0).length,
    errors: findings.filter(finding => finding.level === 'error').length,
    warnings: findings.filter(finding => finding.level === 'warn').length,
  };

  if (parsed.json) {
    console.log(JSON.stringify({
      schema: 'los.cli.tools/v1',
      workspaceRoot,
      summary,
      tools: capabilities.map(capability => ({
        name: capability.name,
        scope: capability.scope,
        permissions: capability.permissions,
        riskLevel: capability.riskLevel,
        sideEffect: capability.sideEffect,
        needsApproval: capability.needsApproval,
        parallelizable: capability.parallelizable,
      })),
      findings,
    }, null, 2));
  } else if (parsed.check) {
    printCheck(summary, findings);
  } else {
    printInventory(capabilities, summary);
  }

  if (summary.errors > 0 || (parsed.strict && summary.warnings > 0)) {
    process.exitCode = 1;
  }
}

function printInventory(capabilities: ToolCapability[], summary: { total: number; scoped: number; empty: number }): void {
  console.log(`tools: ${summary.total} (scoped=${summary.scoped}, empty=${summary.empty})`);
  console.log('name                           scope                          risk  side  permissions');
  for (const capability of capabilities) {
    console.log([
      capability.name.padEnd(30),
      (capability.scope.join(',') || '-').padEnd(30),
      capability.riskLevel.padEnd(4),
      String(capability.sideEffect).padEnd(5),
      capability.permissions.join(',') || '-',
    ].join(' '));
  }
}

function printCheck(summary: { total: number; scoped: number; empty: number; errors: number; warnings: number }, findings: Finding[]): void {
  console.log(`tools check: total=${summary.total} scoped=${summary.scoped} empty=${summary.empty} errors=${summary.errors} warnings=${summary.warnings}`);
  for (const finding of findings) {
    console.log(`${finding.level.toUpperCase()} ${finding.tool}: ${finding.code} — ${finding.message}`);
  }
  if (findings.length === 0) console.log('no declaration drift');
}

function definitionProperties(definition: unknown): Record<string, unknown> {
  const params = (definition as { function?: { parameters?: { properties?: unknown } } } | undefined)
    ?.function?.parameters?.properties;
  return params && typeof params === 'object' && !Array.isArray(params)
    ? params as Record<string, unknown>
    : {};
}

function parseArgs(argv: string[]): {
  check: boolean;
  strict: boolean;
  json: boolean;
  help: boolean;
  workspace?: string;
} {
  const parsed: { check: boolean; strict: boolean; json: boolean; help: boolean; workspace?: string } = {
    check: false,
    strict: false,
    json: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--check') parsed.check = true;
    else if (arg === '--strict') parsed.strict = true;
    else if (arg === '--json') parsed.json = true;
    else if (arg === '--help' || arg === '-h') parsed.help = true;
    else if (arg === '--workspace' || arg === '-w') parsed.workspace = argv[++i];
    else if (arg.startsWith('--workspace=')) parsed.workspace = arg.slice('--workspace='.length);
    else throw new Error(`unknown tools option: ${arg}`);
  }
  return parsed;
}

function printToolsHelp(): void {
  console.log(`los tools

Usage:
  los tools [--json]
  los tools --check [--strict] [--json] [--workspace PATH]

Prints the registered tool capabilities (scope, permissions, risk, side effect).
--check reports declaration drift:
  error  scope id not present in the tool's parameters.properties
  warn   schema exposes a context id but scope is []
  warn   sideEffect=true with no permissions
--strict also fails on warnings.`);
}
