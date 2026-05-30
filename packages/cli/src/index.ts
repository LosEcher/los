#!/usr/bin/env node

import { compatCommand } from './compat.js';

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
type JsonRecord = Record<string, unknown>;

type ParsedArgs = {
  flags: Record<string, string | boolean>;
  positionals: string[];
};

const VERSION = '0.1.0';
const DEFAULT_GATEWAY = 'http://127.0.0.1:8080';

async function main(argv = process.argv.slice(2)): Promise<void> {
  const { command, globalArgs, commandArgs } = splitCommand(argv);

  if (command === 'help' || command === '--help' || command === '-h') {
    printHelp();
    return;
  }
  if (command === 'version' || command === '--version' || command === '-v') {
    console.log(VERSION);
    return;
  }
  if (command === 'chat' || command === 'run') {
    await chatCommand(globalArgs, commandArgs);
    return;
  }
  if (command === 'sessions') {
    await listCommand(globalArgs, commandArgs, '/sessions', renderSessions);
    return;
  }
  if (command === 'tasks') {
    await listCommand(globalArgs, commandArgs, '/tasks', renderTasks);
    return;
  }
  if (command === 'compat') {
    await compatCommand(globalArgs, commandArgs);
    return;
  }
  if (command === 'health') {
    await healthCommand(globalArgs, commandArgs);
    return;
  }

  throw new Error(`Unknown command: ${command}`);
}

async function chatCommand(globalArgs: string[], argv: string[]): Promise<void> {
  const parsed = mergeParsed(parseArgs(globalArgs), parseArgs(argv));
  if (hasFlag(parsed, 'help', 'h')) {
    printChatHelp();
    return;
  }

  const gateway = gatewayUrl(parsed);
  const json = booleanFlag(parsed, 'json');
  const prompt = parsed.positionals.join(' ').trim() || await readStdinPrompt();
  if (!prompt) {
    throw new Error('Prompt is required. Pass it as an argument or pipe it on stdin.');
  }

  const sessionId = stringFlag(parsed, 'session')
    ?? stringFlag(parsed, 'resume')
    ?? stringFlag(parsed, 's');
  const payload: JsonRecord = {
    prompt,
    provider: stringFlag(parsed, 'provider') ?? stringFlag(parsed, 'p'),
    model: stringFlag(parsed, 'model'),
    workspaceRoot: stringFlag(parsed, 'workspace-root') ?? stringFlag(parsed, 'workspace') ?? stringFlag(parsed, 'w'),
    toolMode: stringFlag(parsed, 'tool-mode') ?? 'project-write',
    maxLoops: numberFlag(parsed, 'max-loops'),
    timeoutMs: numberFlag(parsed, 'timeout-ms'),
    sessionId,
    traceId: stringFlag(parsed, 'trace-id'),
    dedupeKey: stringFlag(parsed, 'dedupe-key'),
  };
  removeUndefined(payload);

  if (!json) {
    console.error(`los chat -> ${gateway}`);
    if (sessionId) console.error(`resume session: ${sessionId}`);
  }

  const response = await fetch(`${gateway}/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!response.ok || !response.body) {
    throw new Error(`${response.status} ${response.statusText}: ${await response.text()}`);
  }

  await readSse(response.body, (event, data) => {
    if (json) {
      console.log(JSON.stringify({ event, data }));
      return;
    }
    renderStreamEvent(event, data);
  });
}

async function listCommand(
  globalArgs: string[],
  argv: string[],
  path: string,
  render: (value: unknown, json: boolean) => void,
): Promise<void> {
  const parsed = mergeParsed(parseArgs(globalArgs), parseArgs(argv));
  const json = booleanFlag(parsed, 'json');
  const value = await getJson(`${gatewayUrl(parsed)}${path}`);
  render(value, json);
}

async function healthCommand(globalArgs: string[], argv: string[]): Promise<void> {
  const parsed = mergeParsed(parseArgs(globalArgs), parseArgs(argv));
  const json = booleanFlag(parsed, 'json');
  const value = await getJson(`${gatewayUrl(parsed)}/health`);
  if (json) {
    console.log(JSON.stringify(value));
    return;
  }
  const record = asRecord(value);
  console.log(`status=${String(record.status ?? 'unknown')}`);
  console.log(`service=${String(record.service ?? 'los')}`);
}

async function getJson(url: string): Promise<unknown> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}: ${await response.text()}`);
  }
  return await response.json() as JsonValue;
}

async function readSse(
  body: ReadableStream<Uint8Array>,
  onEvent: (event: string, data: JsonRecord) => void,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let eventName = 'message';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';

    for (const line of lines) {
      if (line.startsWith('event: ')) {
        eventName = line.slice(7).trim();
        continue;
      }
      if (!line.startsWith('data: ')) continue;
      const data = parseJsonRecord(line.slice(6));
      onEvent(eventName, data);
      eventName = 'message';
    }
  }
}

function renderStreamEvent(event: string, data: JsonRecord): void {
  if (event === 'session') {
    console.log(`[session] ${String(data.sessionId ?? '?')} task=${String(data.taskRunId ?? '?')}`);
    return;
  }
  if (event === 'session.resumed') {
    console.log(`[resume] messages=${String(data.messageCount ?? 0)} turns=${String(data.turnCount ?? 0)}`);
    return;
  }
  if (event === 'session.started') {
    const payload = asRecord(data.payload);
    const modelProfile = asRecord(payload.modelProfile);
    const provider = String(payload.provider ?? payload.requestedProvider ?? 'provider');
    const model = String(payload.effectiveModel ?? payload.requestedModel ?? modelProfile.model ?? 'model');
    const protocol = String(modelProfile.protocol ?? '?');
    const reasoning = String(modelProfile.supportsReasoning ?? false);
    console.log(`[start] ${provider}/${model} protocol=${protocol} reasoning=${reasoning}`);
    return;
  }
  if (event === 'task') {
    console.log(`[task] ${String(data.type ?? data.status ?? 'event')} ${String(data.taskRunId ?? '')}`);
    return;
  }
  if (event === 'model.response') {
    const payload = asRecord(data.payload);
    const usage = asRecord(data.usage);
    const tokenText = usage.totalTokens === undefined ? '' : ` tokens=${String(usage.totalTokens)}`;
    console.log(`[model] ${String(data.model ?? payload.provider ?? 'model')}${tokenText} tools=${String(payload.toolCallCount ?? 0)}`);
    const preview = stringValue(payload.textPreview);
    if (preview) console.log(indent(truncate(preview, 600)));
    return;
  }
  if (event === 'tool.call' || event === 'tool.planned' || event === 'tool.approved' || event === 'tool.denied') {
    const payload = asRecord(data.payload);
    const name = String(data.toolName ?? payload.tool ?? 'tool');
    const status = event.split('.')[1] ?? 'call';
    console.log(`[tool:${status}] ${name}`);
    return;
  }
  if (event === 'tool.result') {
    const payload = asRecord(data.payload);
    const ok = payload.ok === false ? 'failed' : 'ok';
    console.log(`[tool:result:${ok}] ${String(data.toolName ?? 'tool')} attempts=${String(payload.attempts ?? 1)}`);
    const preview = stringValue(payload.errorPreview) || stringValue(payload.contentPreview);
    if (preview) console.log(indent(truncate(preview, 800)));
    return;
  }
  if (event === 'turn') {
    console.log(`[turn ${String(data.loopCount ?? '?')}] tools=${Array.isArray(data.toolNames) ? data.toolNames.join(',') || 'none' : '?'}`);
    const text = stringValue(data.text);
    if (text) console.log(indent(truncate(text, 800)));
    return;
  }
  if (event === 'done') {
    console.log('[done]');
    const text = stringValue(data.text);
    if (text) console.log(text);
    return;
  }
  if (event === 'error') {
    console.error(`[error] ${String(data.message ?? 'stream error')}`);
    return;
  }
  console.log(`[${event}] ${truncate(JSON.stringify(data), 1000)}`);
}

function renderSessions(value: unknown, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(value));
    return;
  }
  const rows = Array.isArray(value) ? value : [];
  if (rows.length === 0) {
    console.log('No sessions found.');
    return;
  }
  for (const row of rows) {
    const item = asRecord(row);
    const metadata = asRecord(item.metadata);
    console.log(`${String(item.id)}  ${String(item.updatedAt ?? '')}  provider=${String(metadata.provider ?? '?')} toolMode=${String(metadata.toolMode ?? '?')}`);
  }
}

function renderTasks(value: unknown, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(value));
    return;
  }
  const rows = Array.isArray(value) ? value : [];
  if (rows.length === 0) {
    console.log('No tasks found.');
    return;
  }
  for (const row of rows) {
    const item = asRecord(row);
    const metadata = asRecord(item.metadata);
    console.log(`${String(item.id)}  ${String(item.status ?? '?')}  session=${String(item.sessionId ?? '?')} provider=${String(item.provider ?? '?')} model=${String(item.model ?? metadata.model ?? '?')}`);
  }
}

function parseArgs(argv: string[]): ParsedArgs {
  const flags: Record<string, string | boolean> = {};
  const positionals: string[] = [];
  const aliases: Record<string, string> = {
    g: 'gateway',
    h: 'help',
    p: 'provider',
    s: 'session',
    w: 'workspace',
  };
  const booleanFlags = new Set(['help', 'h', 'json', 'execute', 'version', 'v']);

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

function splitCommand(argv: string[]): { command: string; globalArgs: string[]; commandArgs: string[] } {
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--') break;
    if (token.startsWith('--')) {
      const [key, value] = token.slice(2).split('=', 2);
      if (value === undefined && key === 'gateway' && argv[i + 1] !== undefined) i += 1;
      continue;
    }
    if (/^-[a-zA-Z]$/.test(token)) {
      if (token === '-g' && argv[i + 1] !== undefined) i += 1;
      continue;
    }
    if (token.startsWith('-')) continue;
    return {
      command: token,
      globalArgs: argv.slice(0, i),
      commandArgs: argv.slice(i + 1),
    };
  }
  return {
    command: 'help',
    globalArgs: argv,
    commandArgs: [],
  };
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

async function readStdinPrompt(): Promise<string> {
  if (process.stdin.isTTY) return '';
  process.stdin.setEncoding('utf8');
  let text = '';
  for await (const chunk of process.stdin) {
    text += String(chunk);
  }
  return text.trim();
}

function parseJsonRecord(raw: string): JsonRecord {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return asRecord(parsed);
  } catch {
    return { raw };
  }
}

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function removeUndefined(value: JsonRecord): void {
  for (const key of Object.keys(value)) {
    if (value[key] === undefined) delete value[key];
  }
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}...`;
}

function indent(value: string): string {
  return value.split('\n').map(line => `  ${line}`).join('\n');
}

function printHelp(): void {
  console.log(`los client

Usage:
  los chat [options] <prompt>
  los run [options] <prompt>
  los compat [options] [provider[:model]...]
  los sessions [--gateway URL] [--json]
  los tasks [--gateway URL] [--json]
  los health [--gateway URL] [--json]

Global:
  --gateway, -g URL       Gateway URL, default ${DEFAULT_GATEWAY}
  --json                  Emit JSON lines or raw JSON

Chat:
  --provider, -p NAME     Provider endpoint, e.g. deepseek or openai
  --model NAME            Model override for the selected provider
  --workspace, -w PATH    Workspace root for tools
  --tool-mode MODE        read-only, project-write, or all
  --session, -s ID        Continue writing to a session
  --resume ID             Alias for --session
  --max-loops N           Agent loop limit
  --timeout-ms N          Task timeout
  --trace-id ID           Trace id
  --dedupe-key KEY        Active task dedupe key

Compat:
  --target NAME[:MODEL]   Target provider/model, repeat with comma or positional args
  --probe ID              Probe id, default all built-in probes
  --execute               Execute probes through the gateway; default is dry-run
  --trace-prefix ID       Prefix for per-run trace ids
  --dedupe-prefix KEY     Prefix for per-run dedupe keys
`);
}

function printChatHelp(): void {
  console.log(`los chat

Examples:
  los chat --provider deepseek --workspace . "inspect this repo"
  los chat --provider deepseek --model deepseek-reasoner "inspect this repo"
  los chat --provider openai --tool-mode all "run tests and summarize failures"
  los chat --resume session-123 "continue with the next fix"
  echo "review current structure" | los chat --provider deepseek
`);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`los: ${message}`);
  process.exitCode = 1;
});
