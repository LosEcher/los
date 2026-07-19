import { requestCliJson, resolveCliRequestAuth, type CliRequestAuth } from './cli-http.js';

type SetupState = 'ready' | 'action' | 'optional' | 'unknown';

export type SetupCheck = {
  id: 'gateway' | 'database' | 'auth' | 'provider' | 'executor' | 'workspace' | 'channel' | 'tooling';
  label: string;
  state: SetupState;
  detail: string;
  next?: string;
};

export type SetupReport = {
  gateway: string;
  checks: SetupCheck[];
  summary: { ready: number; action: number; optional: number; unknown: number };
};

type ParsedArgs = {
  values: Record<string, string | boolean>;
  positionals: string[];
};

type QueryResult =
  | { ok: true; value: unknown }
  | { ok: false; status?: number };

const DEFAULT_GATEWAY = 'http://127.0.0.1:8080';

export async function setupCommand(globalArgs: string[], argv: string[]): Promise<void> {
  const parsed = mergeParsed(parseArgs(globalArgs), parseArgs(argv));
  if (parsed.positionals[0] === 'help' || hasFlag(parsed, 'help', 'h')) {
    printSetupHelp();
    return;
  }

  const gateway = (
    stringFlag(parsed, 'gateway')
    ?? stringFlag(parsed, 'g')
    ?? process.env.LOS_GATEWAY_URL
    ?? process.env.LOS_SERVER_URL
    ?? DEFAULT_GATEWAY
  ).replace(/\/+$/, '');
  const auth = resolveCliRequestAuth(parsed.values);
  const report = await collectSetupReport(gateway, auth);

  if (hasFlag(parsed, 'json')) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  printSetupReport(report);
}

async function collectSetupReport(gateway: string, auth: CliRequestAuth = {}): Promise<SetupReport> {
  const paths = [
    '/health',
    '/settings',
    '/onboarding',
    '/workspace',
    '/projects',
    '/services',
    '/nodes',
    '/communication/accounts',
  ] as const;
  const results = await Promise.all(paths.map(path => query(`${gateway}${path}`, auth)));
  const byPath = Object.fromEntries(paths.map((path, index) => [path, results[index]])) as Record<(typeof paths)[number], QueryResult>;

  if (!byPath['/health'].ok) {
    throw new Error(`gateway unavailable at ${gateway}; from a source checkout run: pnpm run setup`);
  }

  const health = asRecord(byPath['/health'].value);
  const settings = valueRecord(byPath['/settings']);
  const onboarding = valueRecord(byPath['/onboarding']);
  const projects = valueRecord(byPath['/projects']);
  const services = valueArray(byPath['/services']);
  const nodes = valueArray(byPath['/nodes']);
  const communication = valueRecord(byPath['/communication/accounts']);
  const protectedResults = paths.slice(3).map(path => byPath[path]);
  const protectedReady = protectedResults.some(result => result.ok);
  const protectedUnauthorized = protectedResults.some(result => !result.ok && result.status === 401);

  const checks: SetupCheck[] = [];
  checks.push({
    id: 'gateway',
    label: 'Gateway',
    state: health.status === 'ok' ? 'ready' : 'action',
    detail: health.status === 'ok' ? 'health endpoint is responding' : 'health endpoint did not report ok',
    next: health.status === 'ok' ? undefined : 'pnpm restart',
  });

  checks.push(databaseCheck(byPath['/services'], byPath['/nodes'], services, nodes));
  checks.push(authCheck(settings, auth, protectedReady, protectedUnauthorized));
  checks.push(providerCheck(onboarding));
  checks.push(executorCheck(settings, nodes, byPath['/nodes']));
  checks.push(workspaceCheck(projects, byPath['/projects']));
  checks.push(channelCheck(communication, byPath['/communication/accounts']));
  checks.push(toolingCheck(onboarding));

  return {
    gateway,
    checks,
    summary: countStates(checks),
  };
}

function databaseCheck(servicesResult: QueryResult, nodesResult: QueryResult, services: unknown[], nodes: unknown[]): SetupCheck {
  if (servicesResult.ok || nodesResult.ok) {
    return {
      id: 'database', label: 'Database', state: 'ready',
      detail: `registry queries succeeded (${services.length} services, ${nodes.length} nodes)`,
    };
  }
  if (isUnauthorized(servicesResult) || isUnauthorized(nodesResult)) {
    return { id: 'database', label: 'Database', state: 'unknown', detail: 'registry check requires gateway auth', next: 'set LOS_AUTH_TOKEN and rerun los setup' };
  }
  return { id: 'database', label: 'Database', state: 'action', detail: 'registry queries failed', next: 'pnpm doctor' };
}

function authCheck(settings: Record<string, unknown>, auth: CliRequestAuth, protectedReady: boolean, protectedUnauthorized: boolean): SetupCheck {
  const enabled = asRecord(settings.auth).enabled === true;
  if (!enabled) return { id: 'auth', label: 'Auth', state: 'ready', detail: 'disabled for this local gateway' };
  if (protectedReady) return { id: 'auth', label: 'Auth', state: 'ready', detail: 'enabled and access token accepted' };
  if (!auth.authToken) return { id: 'auth', label: 'Auth', state: 'action', detail: 'enabled; no access token supplied', next: 'set LOS_AUTH_TOKEN and rerun los setup' };
  return {
    id: 'auth', label: 'Auth', state: 'action',
    detail: protectedUnauthorized ? 'enabled; supplied access token was rejected' : 'enabled; protected readiness checks failed',
    next: 'verify LOS_AUTH_TOKEN without printing it',
  };
}

function providerCheck(onboarding: Record<string, unknown>): SetupCheck {
  const providers = arrayRecords(onboarding.providers);
  const ready = providers.filter(provider => providerReady(provider));
  const verified = ready.filter(provider => hasPassingCompatibility(provider));
  if (ready.length === 0) {
    return { id: 'provider', label: 'Provider', state: 'action', detail: 'no execution-ready provider discovered', next: 'los provider list' };
  }
  if (verified.length === 0) {
    const target = providerName(ready[0]);
    return {
      id: 'provider', label: 'Provider', state: 'action',
      detail: `${ready.length} configured; compatibility evidence is still required`,
      next: `los compat --execute --target ${target} --probe read-context --workspace .`,
    };
  }
  return {
    id: 'provider', label: 'Provider', state: 'ready',
    detail: `${ready.length} configured, ${verified.length} with passing compatibility evidence`,
  };
}

function executorCheck(settings: Record<string, unknown>, nodes: unknown[], nodesResult: QueryResult): SetupCheck {
  const enabled = asRecord(settings.executor).enabled === true;
  if (!enabled) return { id: 'executor', label: 'Executor', state: 'optional', detail: 'disabled; gateway-local execution remains available' };
  if (!nodesResult.ok) {
    return { id: 'executor', label: 'Executor', state: 'unknown', detail: 'enabled; node registry could not be read', next: 'set LOS_AUTH_TOKEN and rerun los setup' };
  }
  const candidates = arrayRecords(nodes).filter(node => {
    const execution = asRecord(node.execution);
    return execution.candidate === true && (node.status === 'online' || node.status === 'ready');
  });
  return candidates.length > 0
    ? { id: 'executor', label: 'Executor', state: 'ready', detail: `${candidates.length} execution candidate nodes online` }
    : { id: 'executor', label: 'Executor', state: 'action', detail: 'enabled; no execution candidate node is online', next: 'pnpm run executor:status' };
}

function workspaceCheck(projects: Record<string, unknown>, result: QueryResult): SetupCheck {
  if (!result.ok) return { id: 'workspace', label: 'Workspace', state: 'unknown', detail: 'project bindings require gateway auth', next: 'set LOS_AUTH_TOKEN and rerun los setup' };
  const count = Array.isArray(projects.projects) ? projects.projects.length : 0;
  return count > 0
    ? { id: 'workspace', label: 'Workspace', state: 'ready', detail: `${count} project bindings available` }
    : { id: 'workspace', label: 'Workspace', state: 'action', detail: 'no project binding exists', next: 'open Web Chat and bind a project' };
}

function channelCheck(communication: Record<string, unknown>, result: QueryResult): SetupCheck {
  if (!result.ok) return { id: 'channel', label: 'Channels', state: 'unknown', detail: 'channel status requires gateway auth', next: 'set LOS_AUTH_TOKEN and rerun los setup' };
  const channels = arrayRecords(communication.channels);
  const live = channels.filter(channel => channel.live === true);
  const connected = channels.filter(channel => channel.status === 'connected');
  return {
    id: 'channel', label: 'Channels', state: live.length > 0 ? 'ready' : 'optional',
    detail: `${live.length} live channel types, ${connected.length} external channels connected`,
    next: connected.length === 0 ? 'open Web Communications to bind an optional channel' : undefined,
  };
}

function toolingCheck(onboarding: Record<string, unknown>): SetupCheck {
  const tools = arrayRecords(onboarding.tools);
  const installed = tools.filter(tool => tool.installed === true);
  const hermes = tools.find(tool => String(tool.name ?? '').toLowerCase().includes('hermes'));
  return {
    id: 'tooling', label: 'Tool discovery', state: installed.length > 0 ? 'ready' : 'optional',
    detail: `${installed.length} external tools detected; Hermes ${hermes?.installed === true ? 'detected' : 'not detected'}`,
  };
}

function printSetupReport(report: SetupReport): void {
  console.log('los setup readiness');
  console.log(`  gateway: ${report.gateway}`);
  console.log('');
  for (const check of report.checks) {
    console.log(`  ${stateMark(check.state)} ${check.label.padEnd(14)} ${check.detail}`);
    if (check.next) console.log(`    next: ${check.next}`);
  }
  console.log('');
  console.log(`  summary: ${report.summary.ready} ready, ${report.summary.action} action, ${report.summary.optional} optional, ${report.summary.unknown} unknown`);
  console.log('  provider discovery and compatibility evidence are reported separately.');
}

function printSetupHelp(): void {
  console.log(`los setup

Inspect gateway, database-backed registries, auth, providers, executor nodes,
workspace bindings, channels, and external tool discovery.

This command never prints credential values. From a source checkout, use
"pnpm run setup" to run doctor, start the runtime idempotently, and then inspect it.`);
}

async function query(url: string, auth: CliRequestAuth): Promise<QueryResult> {
  try {
    return { ok: true, value: await requestCliJson(url, { auth }) };
  } catch (error) {
    const match = error instanceof Error ? error.message.match(/^(\d{3})\b/) : null;
    return { ok: false, status: match ? Number(match[1]) : undefined };
  }
}

function parseArgs(argv: string[]): ParsedArgs {
  const values: Record<string, string | boolean> = {};
  const positionals: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg.startsWith('--')) {
      const [key, inline] = arg.slice(2).split('=', 2);
      if (inline !== undefined) values[key!] = inline;
      else if (argv[i + 1] && !argv[i + 1]!.startsWith('-')) values[key!] = argv[++i]!;
      else values[key!] = true;
    } else if (/^-[a-zA-Z]$/.test(arg)) {
      const key = arg.slice(1);
      if (argv[i + 1] && !argv[i + 1]!.startsWith('-')) values[key] = argv[++i]!;
      else values[key] = true;
    } else positionals.push(arg);
  }
  return { values, positionals };
}

function mergeParsed(first: ParsedArgs, second: ParsedArgs): ParsedArgs {
  return { values: { ...first.values, ...second.values }, positionals: [...first.positionals, ...second.positionals] };
}

function hasFlag(parsed: ParsedArgs, ...keys: string[]): boolean {
  return keys.some(key => parsed.values[key] !== undefined);
}

function stringFlag(parsed: ParsedArgs, key: string): string | undefined {
  const value = parsed.values[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function valueRecord(result: QueryResult): Record<string, unknown> {
  return result.ok ? asRecord(result.value) : {};
}

function valueArray(result: QueryResult): unknown[] {
  return result.ok && Array.isArray(result.value) ? result.value : [];
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function arrayRecords(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? value.map(asRecord) : [];
}

function isUnauthorized(result: QueryResult): boolean {
  return !result.ok && result.status === 401;
}

function providerReady(provider: Record<string, unknown>): boolean {
  const readiness = asRecord(provider.readiness);
  return readiness.ready === true || provider.ready === true;
}

function hasPassingCompatibility(provider: Record<string, unknown>): boolean {
  const compat = asRecord(provider.compatEvidence);
  const latest = asRecord(compat.latest);
  if (latest.passed === true || compat.latestVerdict === 'pass' || compat.latestVerdict === 'passed') return true;
  const evidence = arrayRecords(provider.compatibilityEvidence);
  return evidence.some(item => item.passed === true || item.success === true || item.status === 'passed' || item.verdict === 'pass');
}

function providerName(provider: Record<string, unknown>): string {
  const value = provider.name ?? provider.provider;
  return typeof value === 'string' && /^[A-Za-z0-9._-]+$/.test(value) ? value : 'provider:model';
}

function countStates(checks: SetupCheck[]): SetupReport['summary'] {
  const summary = { ready: 0, action: 0, optional: 0, unknown: 0 };
  for (const check of checks) summary[check.state] += 1;
  return summary;
}

function stateMark(state: SetupState): string {
  if (state === 'ready') return '[ready]';
  if (state === 'action') return '[action]';
  if (state === 'optional') return '[optional]';
  return '[unknown]';
}
