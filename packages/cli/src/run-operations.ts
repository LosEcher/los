import { requestCliJson, resolveCliRequestAuth, type CliRequestAuth } from './cli-http.js';

type JsonRecord = Record<string, unknown>;

type ParsedArgs = {
  flags: Record<string, string | boolean>;
  positionals: string[];
};

const DEFAULT_GATEWAY = 'http://127.0.0.1:8080';

export async function runCommand(globalArgs: string[], argv: string[]): Promise<void> {
  const subcommand = argv[0];
  if (subcommand === 'inspect' || subcommand === 'recover' || subcommand === 'verify' || subcommand === 'state' || subcommand === 'approve' || subcommand === 'revise-plan' || subcommand === 'replay') {
    await runOperationCommand(subcommand, globalArgs, argv.slice(1));
    return;
  }
  throw new Error('run command requires an operation in run-operations.ts');
}

async function runOperationCommand(
  subcommand: 'inspect' | 'recover' | 'verify' | 'state' | 'approve' | 'revise-plan' | 'replay',
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
  const auth = requestAuth(parsed);
  if (subcommand === 'inspect') {
    const value = await requestCliJson(`${gateway}/runs/${encodeURIComponent(runSpecId)}/inspect`, { auth });
    renderRunInspect(value, json);
    return;
  }
  if (subcommand === 'state') {
    const value = await requestCliJson(`${gateway}/runs/${encodeURIComponent(runSpecId)}/state`, { auth });
    renderRunState(value, json);
    return;
  }
  if (subcommand === 'recover') {
    const value = await postRunJson(`${gateway}/runs/${encodeURIComponent(runSpecId)}/recover`, {
      apply: booleanFlag(parsed, 'apply') ? true : undefined,
      intent: stringFlag(parsed, 'intent'),
      reason: stringFlag(parsed, 'reason'),
      actor: stringFlag(parsed, 'actor'),
      staleMs: numberFlag(parsed, 'stale-ms'),
    }, auth);
    renderRunRecover(value, json);
    return;
  }
  if (subcommand === 'approve') {
    const value = await postRunJson(`${gateway}/runs/${encodeURIComponent(runSpecId)}/approve`, {
      actor: stringFlag(parsed, 'actor'),
      reason: stringFlag(parsed, 'reason'),
    }, auth);
    renderRunApprove(value, json);
    return;
  }
  if (subcommand === 'revise-plan') {
    const planArg = stringFlag(parsed, 'plan');
    const value = await postRunJson(`${gateway}/runs/${encodeURIComponent(runSpecId)}/revise-plan`, {
      plan: planArg ? JSON.parse(planArg) : undefined,
      actor: stringFlag(parsed, 'actor'),
      reason: stringFlag(parsed, 'reason'),
    }, auth);
    renderRunRevisePlan(value, json);
    return;
  }
  if (subcommand === 'replay') {
    const since = numberFlag(parsed, 'since') ?? 0;
    const streamSince = numberFlag(parsed, 'stream-since') ?? 0;
    const limit = numberFlag(parsed, 'limit') ?? 500;
    const value = await requestCliJson(
      `${gateway}/runs/${encodeURIComponent(runSpecId)}/stream?since=${since}&streamSince=${streamSince}&limit=${limit}`,
      { auth },
    );
    renderRunReplay(value, json);
    return;
  }
  const value = await postRunJson(`${gateway}/runs/${encodeURIComponent(runSpecId)}/verify`, {
    cwd: stringFlag(parsed, 'cwd'),
    timeoutMs: numberFlag(parsed, 'timeout-ms'),
    outputLimit: numberFlag(parsed, 'output-limit'),
    includeFailed: booleanFlag(parsed, 'skip-failed') ? false : undefined,
  }, auth);
  renderRunVerify(value, json);
}

function requestAuth(parsed: ParsedArgs): CliRequestAuth {
  return resolveCliRequestAuth(parsed.flags);
}

async function postRunJson(url: string, body: JsonRecord, auth: CliRequestAuth): Promise<unknown> {
  return await requestCliJson(url, {
    method: 'POST',
    auth,
    operatorWrite: true,
    json: true,
    body: JSON.stringify(body),
  });
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

function renderRunApprove(value: unknown, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(value));
    return;
  }
  const result = asRecord(value);
  console.log(`run=${String(result.runSpecId ?? '?')} phase=${String(result.phase ?? '?')} previousPhase=${String(result.previousPhase ?? 'null')}`);
  if (typeof result.phaseChangedAt === 'string') console.log(`approvedAt=${result.phaseChangedAt}`);
}

function renderRunRevisePlan(value: unknown, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(value));
    return;
  }
  const result = asRecord(value);
  console.log(`run=${String(result.runSpecId ?? '?')} planRevision=${String(result.planRevision ?? '?')} previousRevision=${String(result.previousRevision ?? 1)}`);
  console.log(`phase=${String(result.phase ?? '?')} previousPhase=${String(result.previousPhase ?? 'null')}`);
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
  const aliases: Record<string, string> = { g: 'gateway', h: 'help' };
  const booleanFlags = new Set(['help', 'h', 'json', 'apply', 'skip-failed']);

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

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {};
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}...`;
}

function renderRunReplay(value: unknown, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(value));
    return;
  }
  const result = asRecord(value);
  const items = Array.isArray(result.items) ? result.items : [];
  console.log(`run=${String(result.runSpecId ?? '?')} session=${String(result.sessionId ?? '?')} items=${items.length} since=${String(result.since ?? 0)} nextSince=${String(result.nextSince ?? 0)} nextStreamSince=${String(result.nextStreamSince ?? 0)}`);

  let textBuf = '';
  for (const item of items) {
    const record = asRecord(item);
    const kind = record.kind as string;
    if (kind === 'stream') {
      const eventType = String(record.eventType ?? '');
      const payload = asRecord(record.payload);
      if (eventType === 'model.delta') {
        const text = String(payload.textDelta ?? '');
        if (text) textBuf += text;
      } else if (eventType === 'tool.call.upsert' || eventType === 'tool_call') {
        if (textBuf) { console.log(textBuf); textBuf = ''; }
        console.log(`[tool:call] ${String(payload.toolName ?? payload.tool ?? 'tool')}`);
      } else if (eventType === 'turn') {
        if (textBuf) { console.log(textBuf); textBuf = ''; }
        console.log(`[turn ${String(payload.loopCount ?? '?')}] tools=${Array.isArray(payload.toolNames) ? payload.toolNames.join(',') || 'none' : '?'}`);
      } else {
        console.log(`[stream:${eventType}] ${truncate(JSON.stringify(payload), 400)}`);
      }
    } else {
      // kind === 'event' — session event
      if (textBuf) { console.log(textBuf); textBuf = ''; }
      const type = String(record.type ?? 'event');
      const payload = asRecord(record.payload);
      if (type === 'model.response') {
        console.log(`[model] turn=${String(record.turn ?? '?')}`);
        const preview = typeof payload.textPreview === 'string' ? payload.textPreview : undefined;
        if (preview) console.log(`  ${truncate(preview, 600)}`);
      } else if (type === 'tool.call' || type === 'tool.planned' || type === 'tool.approved' || type === 'tool.denied') {
        console.log(`[tool:${type.split('.')[1] ?? 'call'}] ${String(record.toolName ?? payload.tool ?? 'tool')}`);
      } else if (type === 'tool.result') {
        const ok = payload.ok === false ? 'failed' : 'ok';
        console.log(`[tool:result:${ok}] ${String(record.toolName ?? 'tool')}`);
      } else if (type === 'session.started' || type === 'session.completed' || type === 'session.resumed' || type === 'session.error') {
        console.log(`[${type}]`);
      } else {
        console.log(`[event:${type}] ${truncate(JSON.stringify(payload), 400)}`);
      }
    }
  }
  if (textBuf) console.log(textBuf);
}

function printRunHelp(): void {
  console.log(`los run operations

Examples:
  los run inspect run-123
  los run state run-123
  los run approve run-123 --reason "plan reviewed, looks good"
  los run revise-plan run-123 --reason "updated scope" --plan '[{"id":"step-1","title":"Add login","description":"...","dependsOnIds":[],"editableSurfaces":[],"completionCriteria":"tests pass"}]'
  los run recover run-123 --stale-ms 300000
  los run recover run-123 --apply --intent cancel
  los run recover run-123 --apply --intent operator-attention --reason "needs approval"
  los run verify run-123 --timeout-ms 120000
  los run replay run-123 --since 50 --stream-since 10
  los run replay run-123 --json

Options:
  --gateway, -g URL       Gateway URL, default ${DEFAULT_GATEWAY}
  --auth-token, -t TOKEN  Gateway token, default LOS_AUTH_TOKEN
  --operator-token TOKEN  Operator token, default LOS_OPERATOR_TOKEN
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
