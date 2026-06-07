#!/usr/bin/env node

import { artifactsCommand } from './artifacts.js';
import { compatCommand } from './compat.js';
import { evalsCommand } from './evals.js';
import { externalSummariesCommand } from './external-summaries.js';
import { resolveClientPath } from './client-path.js';
import { nodesCommand } from './node-commands.js';
import { providerCommand } from './provider.js';

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
  if (command === 'chat') {
    await chatCommand(globalArgs, commandArgs);
    return;
  }
  if (command === 'run') {
    await runCommand(globalArgs, commandArgs);
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
  if (command === 'artifacts') {
    await artifactsCommand(globalArgs, commandArgs);
    return;
  }
  if (command === 'nodes' || command === 'node') {
    await nodesCommand(globalArgs, commandArgs);
    return;
  }
  if (command === 'compat') {
    await compatCommand(globalArgs, commandArgs);
    return;
  }
  if (command === 'provider') {
    await providerCommand(globalArgs, commandArgs);
    return;
  }
  if (command === 'external-summaries' || command === 'external-summary') {
    await externalSummariesCommand(globalArgs, commandArgs);
    return;
  }
  if (command === 'evals' || command === 'eval') {
    await evalsCommand(globalArgs, commandArgs);
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
  const workspaceRoot = stringFlag(parsed, 'workspace-root') ?? stringFlag(parsed, 'workspace') ?? stringFlag(parsed, 'w');
  const payload: JsonRecord = {
    prompt,
    provider: stringFlag(parsed, 'provider') ?? stringFlag(parsed, 'p'),
    model: stringFlag(parsed, 'model'),
    workspaceRoot: workspaceRoot ? resolveClientPath(workspaceRoot) : undefined,
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

async function runCommand(globalArgs: string[], argv: string[]): Promise<void> {
  const subcommand = argv[0];
  if (subcommand === 'inspect' || subcommand === 'recover' || subcommand === 'verify' || subcommand === 'state') {
    await runOperationCommand(subcommand, globalArgs, argv.slice(1));
    return;
  }
  await chatCommand(globalArgs, argv);
}

async function runOperationCommand(
  subcommand: 'inspect' | 'recover' | 'verify' | 'state',
  globalArgs: string[],
  argv: string[],
): Promise<void> {
  const parsed = mergeParsed(parseArgs(globalArgs), parseArgs(argv));
  if (hasFlag(parsed, 'help', 'h')) {
    printRunHelp();
    return;
  }
  const runSpecId = parsed.positionals[0];
  if (!runSpecId) throw new Error(`Run id is required. Usage: los run ${subcommand} <run-id>`);

  const gateway = gatewayUrl(parsed);
  const json = booleanFlag(parsed, 'json');
  if (subcommand === 'inspect') {
    const value = await getJson(`${gateway}/runs/${encodeURIComponent(runSpecId)}/inspect`);
    renderRunInspect(value, json);
    return;
  }
  if (subcommand === 'state') {
    const value = await getJson(`${gateway}/runs/${encodeURIComponent(runSpecId)}/state`);
    renderRunState(value, json);
    return;
  }
  if (subcommand === 'recover') {
    const value = await postJson(`${gateway}/runs/${encodeURIComponent(runSpecId)}/recover`, {
      apply: booleanFlag(parsed, 'apply') ? true : undefined,
      intent: stringFlag(parsed, 'intent'),
      reason: stringFlag(parsed, 'reason'),
      actor: stringFlag(parsed, 'actor'),
      staleMs: numberFlag(parsed, 'stale-ms'),
    });
    renderRunRecover(value, json);
    return;
  }
  const value = await postJson(`${gateway}/runs/${encodeURIComponent(runSpecId)}/verify`, {
    cwd: stringFlag(parsed, 'cwd'),
    timeoutMs: numberFlag(parsed, 'timeout-ms'),
    outputLimit: numberFlag(parsed, 'output-limit'),
    includeFailed: booleanFlag(parsed, 'skip-failed') ? false : undefined,
  });
  renderRunVerify(value, json);
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

async function postJson(url: string, body: JsonRecord): Promise<unknown> {
  removeUndefined(body);
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
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

function renderRunInspect(value: unknown, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(value));
    return;
  }
  const graph = asRecord(value);
  const counts = asRecord(graph.counts);
  const warnings = Array.isArray(graph.warnings) ? graph.warnings : [];
  const state = asRecord(graph.state);
  console.log(`run=${String(graph.runSpecId ?? '?')} session=${String(graph.sessionId ?? '?')}`);
  if (Object.keys(state).length > 0) renderRunState(state, false);
  console.log(`nodes run=${String(counts.run_spec ?? 0)} tasks=${String(counts.task_run ?? 0)} events=${String(counts.session_event ?? 0)} tools=${String(counts.tool_call_state ?? 0)} verifications=${String(counts.verification_record ?? 0)}`);
  console.log(`edges=${Array.isArray(graph.edges) ? graph.edges.length : 0} warnings=${warnings.length}`);
  for (const warning of warnings) console.log(`warning: ${String(warning)}`);
}

function renderRunState(value: unknown, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(value));
    return;
  }
  const state = asRecord(value);
  const counts = asRecord(state.counts);
  const taskCounts = asRecord(counts.taskRuns);
  const verificationCounts = asRecord(counts.verificationRecords);
  console.log(`state phase=${String(state.phase ?? '?')} action=${String(state.action ?? '?')}`);
  if (typeof state.summary === 'string') console.log(`summary: ${state.summary}`);
  console.log(`counts tasks=${String(taskCounts.total ?? 0)} active=${Number(taskCounts.queued ?? 0) + Number(taskCounts.running ?? 0)} failed=${String(taskCounts.failed ?? 0)} verifications=${String(verificationCounts.total ?? 0)} blocked=${Number(verificationCounts.required ?? 0) + Number(verificationCounts.running ?? 0) + Number(verificationCounts.failed ?? 0)}`);
  const blockers = Array.isArray(state.blockers) ? state.blockers : [];
  for (const blocker of blockers) {
    const record = asRecord(blocker);
    const ids = Array.isArray(record.ids) ? record.ids.map(String).join(',') : '';
    console.log(`blocker ${String(record.kind ?? '?')}: ${String(record.message ?? '')}${ids ? ` [${ids}]` : ''}`);
  }
}

function renderRunRecover(value: unknown, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(value));
    return;
  }
  const root = asRecord(value);
  if (typeof root.action === 'string') {
    console.log(`transition=${String(root.action)} run=${String(root.runSpecId ?? '?')} status=${String(root.runSpecStatus ?? '?')}`);
    if (typeof root.reason === 'string') console.log(`reason: ${root.reason}`);
    for (const key of ['transitionedToolCallIds', 'transitionedTaskRunIds', 'liveCancelledTaskRunIds']) {
      const ids = Array.isArray(root[key]) ? root[key] : [];
      if (ids.length > 0) console.log(`${key}=${ids.map(String).join(',')}`);
    }
  }
  const decision = asRecord(root.decision ?? root);
  console.log(`status=${String(decision.status ?? '?')} recommendation=${String(decision.recommendation ?? '?')}`);
  for (const key of ['resumeToolCallIds', 'retryToolCallIds', 'cancelToolCallIds', 'operatorAttentionToolCallIds']) {
    const ids = Array.isArray(decision[key]) ? decision[key] : [];
    if (ids.length > 0) console.log(`${key}=${ids.map(String).join(',')}`);
  }
  const reasons = Array.isArray(decision.reasons) ? decision.reasons : [];
  for (const reason of reasons) console.log(`reason: ${String(reason)}`);
}

function renderRunVerify(value: unknown, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(value));
    return;
  }
  const result = asRecord(value);
  const decision = asRecord(result.decision);
  const ran = Array.isArray(result.ranRecordIds) ? result.ranRecordIds : [];
  console.log(`run=${String(result.runSpecId ?? '?')} verification=${String(decision.status ?? '?')} ran=${ran.length}`);
  for (const id of ran) console.log(`ran: ${String(id)}`);
  const blocked = Array.isArray(decision.blockedVerificationRecordIds) ? decision.blockedVerificationRecordIds : [];
  for (const id of blocked) console.log(`blocked: ${String(id)}`);
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
  const booleanFlags = new Set(['help', 'h', 'json', 'execute', 'version', 'v', 'apply']);

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
  los run <inspect|state|recover|verify> <run-id> [options]
  los compat [options] [provider[:model]...]
  los provider <list|promote> [options]
  los evals <list|summary|compare|record> [options]
  los external-summaries <list|import> [options]
  los artifacts <list|put|get|delete> [options]
  los nodes <list|commands|command> [options]
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

Run operations:
  inspect RUN_ID          Print runtime evidence graph counts and warnings
  state RUN_ID            Print recovery-grade run phase, next action, and blockers
  recover RUN_ID          Print tool recovery decision; add --apply to transition cancel/operator-attention
  verify RUN_ID           Run required verification records
  --stale-ms N            Recovery stale threshold
  --cwd PATH              Verification working directory
  --output-limit N        Verification output summary limit
  --skip-failed           Do not rerun failed verification records

Compat:
  --target NAME[:MODEL]   Target provider/model, repeat with comma or positional args
  --probe ID              Probe id, default all built-in probes
  --execute               Execute probes through the gateway; default is dry-run
  --trace-prefix ID       Prefix for per-run trace ids
  --dedupe-prefix KEY     Prefix for per-run dedupe keys
  Default target is the required DeepSeek compatibility gate; pass --target for advisory providers.

Artifacts:
  list | put | get | delete
  Run "los artifacts --help" for artifact transfer options.

External summaries:
  list | import --file summary.json
  Import redacted external tool summaries without making them runtime replay evidence.

Evals:
  list | summary | compare | record --run RUN_ID --success true|false
  Record, list, summarize, or compare run quality eval metrics.

Nodes:
  list | commands | command
  Run "los nodes --help" for node registry and command options.
`);
}

function printRunHelp(): void {
  console.log(`los run operations

Examples:
  los run inspect run-123
  los run state run-123
  los run recover run-123 --stale-ms 300000
  los run recover run-123 --apply --intent cancel
  los run recover run-123 --apply --intent operator-attention --reason "needs approval"
  los run verify run-123 --timeout-ms 120000

Options:
  --gateway, -g URL       Gateway URL, default ${DEFAULT_GATEWAY}
  --json                  Emit raw JSON
  --intent MODE           recover, cancel, or operator-attention
  --apply                 Apply cancel or operator-attention as a recovery transition
  --reason TEXT           Recovery transition reason
  --actor TEXT            Operator or system actor for the transition event
  --stale-ms N            Recovery stale threshold
  --cwd PATH              Verification working directory
  --timeout-ms N          Verification timeout
  --output-limit N        Verification output summary limit
  --skip-failed           Do not rerun failed verification records
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
