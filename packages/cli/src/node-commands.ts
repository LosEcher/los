type JsonRecord = Record<string, unknown>;

type ParsedArgs = {
  flags: Record<string, string | boolean>;
  positionals: string[];
};

const DEFAULT_GATEWAY = 'http://127.0.0.1:8080';
const COMMANDS = new Set(['status', 'probe', 'drain', 'promote', 'restart', 'upgrade', 'rollback']);

export async function nodesCommand(globalArgs: string[], argv: string[]): Promise<void> {
  const parsed = mergeParsed(parseArgs(globalArgs), parseArgs(argv));
  const [action = 'list', ...rest] = parsed.positionals;
  if (hasFlag(parsed, 'help', 'h')) {
    printNodesHelp();
    return;
  }

  if (action === 'list' || action === 'ls') {
    await listNodes(parsed);
    return;
  }
  if (action === 'commands') {
    await listNodeCommands(parsed, rest);
    return;
  }
  if (action === 'command' || action === 'cmd') {
    await postNodeCommand(parsed, rest);
    return;
  }
  if (COMMANDS.has(action)) {
    await postNodeCommand(parsed, [stringFlag(parsed, 'node-id') ?? stringFlag(parsed, 'node') ?? '', action, ...rest]);
    return;
  }

  throw new Error(`Unknown nodes command: ${action}`);
}

async function listNodes(parsed: ParsedArgs): Promise<void> {
  const value = await getJson(`${gatewayUrl(parsed)}/nodes`);
  renderNodes(value, booleanFlag(parsed, 'json'));
}

async function listNodeCommands(parsed: ParsedArgs, rest: string[]): Promise<void> {
  const nodeId = stringFlag(parsed, 'node-id') ?? stringFlag(parsed, 'node') ?? rest[0];
  const limit = stringFlag(parsed, 'limit');
  const params = new URLSearchParams();
  if (limit) params.set('limit', limit);
  const suffix = params.toString() ? `?${params.toString()}` : '';
  const path = nodeId
    ? `/nodes/${encodeURIComponent(nodeId)}/commands${suffix}`
    : `/node-commands${suffix}`;
  const value = await getJson(`${gatewayUrl(parsed)}${path}`);
  renderNodeCommands(value, booleanFlag(parsed, 'json'));
}

async function postNodeCommand(parsed: ParsedArgs, rest: string[]): Promise<void> {
  const [nodeId, command] = rest;
  if (!nodeId) throw new Error('nodes command requires a node id');
  if (!command || !COMMANDS.has(command)) {
    throw new Error('nodes command requires one of: status, probe, drain, promote, restart, upgrade, rollback');
  }

  const payload: JsonRecord = {
    command,
    commandId: stringFlag(parsed, 'command-id'),
    requestedBy: stringFlag(parsed, 'requested-by'),
    traceId: stringFlag(parsed, 'trace-id'),
    targetVersion: stringFlag(parsed, 'target-version') ?? stringFlag(parsed, 'version'),
    timeoutMs: numberFlag(parsed, 'timeout-ms'),
    reason: stringFlag(parsed, 'reason'),
    args: parseArgsJson(parsed),
  };
  removeUndefined(payload);

  const result = await sendJsonAllowError(`${gatewayUrl(parsed)}/nodes/${encodeURIComponent(nodeId)}/commands`, {
    method: 'POST',
    body: payload,
  });
  renderNodeCommandResponse(result.value, booleanFlag(parsed, 'json'));
  if (!result.ok) process.exitCode = 1;
}

async function getJson(url: string): Promise<unknown> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}: ${await response.text()}`);
  }
  return await response.json() as unknown;
}

async function sendJsonAllowError(url: string, input: { method: string; body: JsonRecord }): Promise<{ ok: boolean; value: unknown }> {
  const response = await fetch(url, {
    method: input.method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input.body),
  });
  const text = await response.text();
  const value = text ? JSON.parse(text) as unknown : {};
  return { ok: response.ok, value };
}

function renderNodes(value: unknown, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(value));
    return;
  }
  const rows = Array.isArray(value) ? value : [];
  if (rows.length === 0) {
    console.log('No nodes found.');
    return;
  }
  for (const row of rows) {
    const item = asRecord(row);
    const execution = asRecord(item.execution);
    const candidate = execution.candidate === undefined ? '?' : String(execution.candidate);
    const mode = execution.mode ? ` mode=${String(execution.mode)}` : '';
    console.log(`${String(item.nodeId)} kind=${String(item.nodeKind ?? '?')} status=${String(item.status ?? '?')} rollout=${String(item.rolloutState ?? '?')} candidate=${candidate}${mode}`);
  }
}

function renderNodeCommands(value: unknown, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(value));
    return;
  }
  const rows = Array.isArray(value) ? value : [];
  if (rows.length === 0) {
    console.log('No node commands found.');
    return;
  }
  for (const row of rows) {
    renderNodeCommand(row);
  }
}

function renderNodeCommandResponse(value: unknown, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(value));
    return;
  }
  const record = asRecord(asRecord(value).command);
  renderNodeCommand(record);
}

function renderNodeCommand(value: unknown): void {
  const command = asRecord(value);
  console.log(`${String(command.commandId ?? '?')} node=${String(command.nodeId ?? '?')} command=${String(command.command ?? '?')} status=${String(command.status ?? '?')}`);
  if (command.error) console.log(indent(`error=${String(command.error)}`));
  const node = asRecord(asRecord(command.output).node);
  if (node.nodeId) {
    const execution = asRecord(node.execution);
    console.log(indent(`node status=${String(node.status ?? '?')} rollout=${String(node.rolloutState ?? '?')} candidate=${String(execution.candidate ?? '?')}`));
  }
  const nextAction = asRecord(command.output).nextAction;
  if (nextAction) console.log(indent(`next=${String(nextAction)}`));
}

function parseArgs(argv: string[]): ParsedArgs {
  const flags: Record<string, string | boolean> = {};
  const positionals: string[] = [];
  const aliases: Record<string, string> = {
    g: 'gateway',
    h: 'help',
  };
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
      if (booleanFlags.has(key)) {
        flags[key] = true;
        continue;
      }
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('-')) {
        flags[key] = next;
        i += 1;
      } else {
        flags[key] = true;
      }
      continue;
    }
    positionals.push(token);
  }

  return { flags, positionals };
}

function mergeParsed(first: ParsedArgs, second: ParsedArgs): ParsedArgs {
  return {
    flags: { ...first.flags, ...second.flags },
    positionals: [...first.positionals, ...second.positionals],
  };
}

function gatewayUrl(parsed: ParsedArgs): string {
  const raw = stringFlag(parsed, 'gateway')
    ?? stringFlag(parsed, 'g')
    ?? process.env.LOS_GATEWAY_URL
    ?? process.env.LOS_SERVER_URL
    ?? envServerUrl()
    ?? DEFAULT_GATEWAY;
  return raw.replace(/\/+$/, '');
}

function envServerUrl(): string | undefined {
  if (!process.env.SERVER_HOST && !process.env.SERVER_PORT) return undefined;
  return `http://${process.env.SERVER_HOST ?? '127.0.0.1'}:${process.env.SERVER_PORT ?? '8080'}`;
}

function hasFlag(parsed: ParsedArgs, ...keys: string[]): boolean {
  return keys.some(key => parsed.flags[key] !== undefined);
}

function booleanFlag(parsed: ParsedArgs, key: string): boolean {
  return parsed.flags[key] === true || parsed.flags[key] === 'true' || parsed.flags[key] === '1';
}

function stringFlag(parsed: ParsedArgs, key: string): string | undefined {
  const value = parsed.flags[key];
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function numberFlag(parsed: ParsedArgs, key: string): number | undefined {
  const value = stringFlag(parsed, key);
  if (!value) return undefined;
  const parsedNumber = Number(value);
  if (!Number.isFinite(parsedNumber)) return undefined;
  return parsedNumber;
}

function parseArgsJson(parsed: ParsedArgs): Record<string, unknown> | undefined {
  const raw = stringFlag(parsed, 'args-json');
  if (!raw) return undefined;
  const parsedValue = JSON.parse(raw) as unknown;
  if (!parsedValue || typeof parsedValue !== 'object' || Array.isArray(parsedValue)) {
    throw new Error('--args-json must be a JSON object');
  }
  return parsedValue as Record<string, unknown>;
}

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {};
}

function removeUndefined(value: JsonRecord): void {
  for (const key of Object.keys(value)) {
    if (value[key] === undefined) delete value[key];
  }
}

function indent(value: string): string {
  return value.split('\n').map(line => `  ${line}`).join('\n');
}

function printNodesHelp(): void {
  console.log(`los nodes

Usage:
  los nodes list [--json]
  los nodes commands [NODE_ID] [--limit N] [--json]
  los nodes command NODE_ID <status|probe|drain|promote|restart|upgrade|rollback> [options]
  los nodes --node-id NODE_ID <status|probe|drain|promote|restart|upgrade|rollback> [options]

Options:
  --gateway, -g URL       Gateway URL, default ${DEFAULT_GATEWAY}
  --reason TEXT           Audit reason stored with the command
  --target-version VER    Required for upgrade
  --requested-by USER     Audit actor
  --command-id ID         Idempotent command id
  --timeout-ms N          Command timeout hint
  --args-json JSON        Extra command arguments as a JSON object
`);
}
