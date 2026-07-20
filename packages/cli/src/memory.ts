import { requestCliJson, resolveCliRequestAuth } from './cli-http.js';

type ParsedArgs = {
  flags: Record<string, string | boolean>;
  positionals: string[];
};

const DEFAULT_GATEWAY = 'http://127.0.0.1:8080';

export async function memoryCommand(globalArgs: string[], argv: string[]): Promise<void> {
  const parsed = mergeParsed(parseArgs(globalArgs), parseArgs(argv));
  const [action = 'list'] = parsed.positionals;
  if (hasFlag(parsed, 'help', 'h')) {
    printMemoryHelp();
    return;
  }

  if (action === 'compact') {
    await compactMemory(parsed);
    return;
  }
  if (action === 'compactions' || action === 'ls-compactions') {
    await listMemoryCompactions(parsed);
    return;
  }
  if (action === 'active-rules' || action === 'rules') {
    await listActiveRules(parsed);
    return;
  }
  if (action === 'retrieve') {
    await retrieveMemory(parsed);
    return;
  }

  throw new Error(`Unknown memory command: ${action}`);
}

async function compactMemory(parsed: ParsedArgs): Promise<void> {
  const sessionId = stringFlag(parsed, 'session-id') ?? stringFlag(parsed, 'session') ?? parsed.positionals[1];
  if (!sessionId) throw new Error('memory compact requires --session-id or a session ID positional argument');
  const payload: Record<string, unknown> = {
    sessionId,
    runSpecId: stringFlag(parsed, 'run-spec-id') ?? stringFlag(parsed, 'run'),
  };
  removeUndefined(payload);
  const data = await requestCliJson(`${gatewayUrl(parsed)}/memory/compact`, {
    method: 'POST',
    auth: resolveCliRequestAuth(parsed.flags),
    json: true,
    body: JSON.stringify(payload),
  }) as Record<string, unknown>;
  renderCompaction(data, booleanFlag(parsed, 'json'));
}

async function listMemoryCompactions(parsed: ParsedArgs): Promise<void> {
  const params = new URLSearchParams();
  addQuery(params, 'sessionId', stringFlag(parsed, 'session-id') ?? stringFlag(parsed, 'session'));
  addQuery(params, 'runSpecId', stringFlag(parsed, 'run-spec-id') ?? stringFlag(parsed, 'run'));
  addQuery(params, 'limit', stringFlag(parsed, 'limit'));
  const suffix = params.toString() ? `?${params.toString()}` : '';
  const data = await requestCliJson(`${gatewayUrl(parsed)}/memory/compactions${suffix}`, {
    auth: resolveCliRequestAuth(parsed.flags),
  }) as Record<string, unknown>;
  if (booleanFlag(parsed, 'json')) {
    console.log(JSON.stringify(data));
    return;
  }
  const compactions = Array.isArray(data.compactions) ? data.compactions : [];
  console.log(`Memory compactions: ${compactions.length}`);
  for (const item of compactions) {
    const c = item as Record<string, unknown>;
    const summary = (c.summary as Record<string, unknown>) ?? {};
    console.log(`  ${String(c.id ?? '?')} session=${String(c.sessionId ?? '?').slice(0, 12)} obs=${String(summary.observationCount ?? 0)} tasks=${String(summary.taskRunCount ?? 0)} evals=${String(summary.evalCount ?? 0)} confidence=${String(c.confidence ?? 0)}`);
  }
}

function renderCompaction(data: Record<string, unknown>, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(data));
    return;
  }
  const c = (data.compaction as Record<string, unknown>) ?? {};
  const summary = (c.summary as Record<string, unknown>) ?? {};
  console.log(`Compaction: ${String(c.id ?? '?')}`);
  console.log(`  session: ${String(c.sessionId ?? '?')}`);
  console.log(`  evidence: observations=${String(summary.observationCount ?? 0)} tasks=${String(summary.taskRunCount ?? 0)} evals=${String(summary.evalCount ?? 0)}`);
  console.log(`  confidence: ${String(c.confidence ?? 0)}`);
  const candidates = Array.isArray(c.proceduralCandidates) ? c.proceduralCandidates : [];
  if (candidates.length > 0) {
    console.log(`  procedural candidates: ${candidates.length}`);
    for (const cand of candidates) {
      const r = cand as Record<string, unknown>;
      console.log(`    - ${String(r.name ?? '?')} severity=${String(r.severity ?? 'warn')} confidence=${String(r.confidence ?? 0)}`);
    }
  }
}

function parseArgs(argv: string[]): ParsedArgs {
  const flags: Record<string, string | boolean> = {};
  const positionals: string[] = [];
  const aliases: Record<string, string> = { g: 'gateway', h: 'help', t: 'auth-token' };
  const booleanFlags = new Set(['help', 'h', 'json']);

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--') {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (token.startsWith('--')) {
      const [rawKey, inlineValue] = token.slice(2).split('=', 2);
      if (inlineValue !== undefined) {
        flags[rawKey] = inlineValue;
        continue;
      }
      if (booleanFlags.has(rawKey)) {
        flags[rawKey] = true;
        continue;
      }
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('-')) {
        flags[rawKey] = next;
        i += 1;
      } else {
        flags[rawKey] = true;
      }
      continue;
    }
    if (/^-[a-zA-Z]$/.test(token)) {
      const key = aliases[token.slice(1)] ?? token.slice(1);
      if (booleanFlags.has(key)) { flags[key] = true; continue; }
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('-')) { flags[key] = next; i += 1; }
      else { flags[key] = true; }
      continue;
    }
    positionals.push(token);
  }
  return { flags, positionals };
}

function mergeParsed(first: ParsedArgs, second: ParsedArgs): ParsedArgs {
  return { flags: { ...first.flags, ...second.flags }, positionals: [...first.positionals, ...second.positionals] };
}

function gatewayUrl(parsed: ParsedArgs): string {
  return (stringFlag(parsed, 'gateway') ?? stringFlag(parsed, 'g') ?? DEFAULT_GATEWAY).replace(/\/+$/, '');
}

function stringFlag(parsed: ParsedArgs, key: string): string | undefined {
  const value = parsed.flags[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function booleanFlag(parsed: ParsedArgs, key: string): boolean {
  return parsed.flags[key] === true || parsed.flags[key] === 'true' || parsed.flags[key] === '1';
}

function hasFlag(parsed: ParsedArgs, ...keys: string[]): boolean {
  return keys.some(key => parsed.flags[key] !== undefined);
}

function addQuery(params: URLSearchParams, key: string, value: string | undefined): void {
  if (value) params.set(key, value);
}

function removeUndefined(value: Record<string, unknown>): void {
  for (const key of Object.keys(value)) if (value[key] === undefined) delete value[key];
}

async function listActiveRules(parsed: ParsedArgs): Promise<void> {
  const params = new URLSearchParams();
  addQuery(params, 'runSpecId', stringFlag(parsed, 'run-spec-id') ?? stringFlag(parsed, 'run'));
  addQuery(params, 'limit', stringFlag(parsed, 'limit'));
  const suffix = params.toString() ? `?${params.toString()}` : '';
  const data = await requestCliJson(`${gatewayUrl(parsed)}/memory/active-rules${suffix}`, {
    auth: resolveCliRequestAuth(parsed.flags),
  }) as Record<string, unknown>;
  if (booleanFlag(parsed, 'json')) {
    console.log(JSON.stringify(data));
    return;
  }
  const rules = Array.isArray(data.rules) ? data.rules : [];
  console.log(`Active procedural rules: ${rules.length}`);
  for (const item of rules) {
    const r = item as Record<string, unknown>;
    const sev = String(r.severity ?? 'info');
    const icon = sev === 'error' ? '⚠️' : sev === 'warn' ? '⚡' : 'ℹ️';
    console.log(`  ${icon} ${String(r.name ?? '?')} (confidence: ${Number(r.confidence ?? 0).toFixed(0)}%)`);
  }
}

async function retrieveMemory(parsed: ParsedArgs): Promise<void> {
  const sessionId = stringFlag(parsed, 'session-id') ?? stringFlag(parsed, 'session') ?? parsed.positionals[1];
  const payload: Record<string, unknown> = {
    taskState: stringFlag(parsed, 'task-state') ?? 'running',
    runPhase: stringFlag(parsed, 'run-phase'),
    sessionId,
    runSpecId: stringFlag(parsed, 'run-spec-id') ?? stringFlag(parsed, 'run'),
    maxObservationsPerLayer: stringFlag(parsed, 'max-per-layer'),
  };
  removeUndefined(payload);
  const data = await requestCliJson(`${gatewayUrl(parsed)}/memory/retrieve`, {
    method: 'POST',
    auth: resolveCliRequestAuth(parsed.flags),
    json: true,
    body: JSON.stringify(payload),
  }) as Record<string, unknown>;
  if (booleanFlag(parsed, 'json')) {
    console.log(JSON.stringify(data));
    return;
  }
  const rules = Array.isArray(data.activeRules) ? data.activeRules : [];
  const layers = Array.isArray(data.queriedLayers) ? data.queriedLayers : [];
  console.log(`Memory retrieval — layers: ${layers.join(', ')}`);
  if (rules.length > 0) {
    console.log(`Active rules: ${rules.length}`);
    for (const item of rules) {
      const r = item as Record<string, unknown>;
      console.log(`  - ${String(r.name ?? '?')} (confidence: ${Number(r.confidence ?? 0).toFixed(0)}%)`);
    }
  }
  const byLayer = data.observationsByLayer as Record<string, unknown> | undefined;
  if (byLayer) {
    for (const layer of layers) {
      const obs = Array.isArray(byLayer[layer as string]) ? byLayer[layer as string] as Array<Record<string, unknown>> : [];
      console.log(`  ${layer}: ${obs.length} observations`);
    }
  }
}

function printMemoryHelp(): void {
  console.log(`los memory

Compact session memory, list compactions, retrieve active rules and memory.

Usage:
  los memory compact --session-id SESSION_ID [--run RUN_SPEC_ID] [--json]
  los memory compactions [--session-id SESSION_ID] [--limit N] [--json]
  los memory active-rules [--run RUN_SPEC_ID] [--limit N] [--json]
  los memory retrieve [--session-id SESSION_ID] [--task-state STATE] [--json]

Commands:
  compact           Compact a session into a structured summary
  compactions       List memory compaction records
  active-rules      List active procedural rules from compactions
  retrieve          Route memory retrieval by task state

Options:
  --gateway, -g URL
  --auth-token, -t TOKEN  Gateway token, default LOS_AUTH_TOKEN
`);
}
