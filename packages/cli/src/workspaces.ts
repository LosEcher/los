import { requestCliJson, resolveCliRequestAuth } from './cli-http.js';

type ParsedArgs = { flags: Record<string, string | boolean>; positionals: string[] };
type JsonRecord = Record<string, unknown>;
const DEFAULT_GATEWAY = 'http://127.0.0.1:8080';

export async function workspacesCommand(globalArgs: string[], argv: string[]): Promise<void> {
  const subcommand = argv[0];
  const parsed = mergeParsed(parseArgs(globalArgs), parseArgs(argv.slice(1)));
  if (!subcommand || subcommand === 'help' || hasFlag(parsed, 'help', 'h')) {
    printWorkspacesHelp();
    return;
  }
  const gateway = gatewayUrl(parsed);
  const auth = resolveCliRequestAuth(parsed.flags);
  const json = booleanFlag(parsed, 'json');

  if (subcommand === 'plan') {
    const graphId = requirePosition(parsed, 0, 'graph id');
    const projectId = stringFlag(parsed, 'project') ?? stringFlag(parsed, 'project-id');
    const query = projectId ? `?projectId=${encodeURIComponent(projectId)}` : '';
    const value = await requestCliJson(`${gateway}/agent-graphs/${encodeURIComponent(graphId)}/workspace-plan${query}`, { auth });
    renderPlan(value, json);
    return;
  }
  if (subcommand === 'apply') {
    const graphId = requirePosition(parsed, 0, 'graph id');
    const taskIds = commaList(stringFlag(parsed, 'tasks'));
    const value = await requestCliJson(`${gateway}/agent-graphs/${encodeURIComponent(graphId)}/workspaces`, {
      method: 'POST', auth, operatorWrite: true, json: true,
      body: JSON.stringify({
        projectId: stringFlag(parsed, 'project') ?? stringFlag(parsed, 'project-id'),
        taskIds: taskIds.length > 0 ? taskIds : undefined,
      }),
    });
    renderApply(value, json);
    return;
  }
  if (subcommand === 'list') {
    const query = new URLSearchParams();
    for (const [flag, param] of [['graph', 'graphId'], ['task', 'taskId'], ['project', 'projectId'], ['status', 'status']] as const) {
      const value = stringFlag(parsed, flag);
      if (value) query.set(param, value);
    }
    const limit = stringFlag(parsed, 'limit');
    if (limit) query.set('limit', limit);
    const suffix = query.size > 0 ? `?${query.toString()}` : '';
    const value = await requestCliJson(`${gateway}/managed-workspaces${suffix}`, { auth });
    renderList(value, json);
    return;
  }
  if (subcommand === 'inspect') {
    const workspaceId = requirePosition(parsed, 0, 'workspace id');
    const value = await requestCliJson(`${gateway}/managed-workspaces/${encodeURIComponent(workspaceId)}`, { auth });
    renderInspect(value, json);
    return;
  }
  if (subcommand === 'backup' || subcommand === 'release') {
    const workspaceId = requirePosition(parsed, 0, 'workspace id');
    const body = subcommand === 'release' ? { confirm: stringFlag(parsed, 'confirm') } : {};
    const value = await requestCliJson(`${gateway}/managed-workspaces/${encodeURIComponent(workspaceId)}/${subcommand}`, {
      method: 'POST', auth, operatorWrite: true, json: true, body: JSON.stringify(body),
    });
    renderWorkspace(value, json);
    return;
  }
  throw new Error(`Unknown workspaces command: ${subcommand}`);
}

function renderPlan(value: unknown, json: boolean): void {
  if (json) return printJson(value);
  const plan = asRecord(value);
  console.log(`graph=${String(plan.graphId ?? '?')} project=${String(plan.projectId ?? '?')}`);
  for (const item of array(value, 'tasks')) {
    const task = asRecord(item);
    const surfaces = Array.isArray(task.editableSurfaces) ? task.editableSurfaces.map(String).join(',') : '';
    console.log(`${task.eligible === true ? 'eligible' : 'blocked'} ${String(task.taskId ?? '?')} surfaces=${surfaces || 'none'}${task.reason ? ` reason=${String(task.reason)}` : ''}`);
  }
}

function renderApply(value: unknown, json: boolean): void {
  if (json) return printJson(value);
  const root = asRecord(value);
  console.log(`graph=${String(root.graphId ?? '?')} project=${String(root.projectId ?? '?')}`);
  for (const item of array(value, 'results')) {
    const result = asRecord(item);
    const workspace = asRecord(result.workspace);
    console.log(`${result.error ? 'failed' : 'created'} task=${String(result.taskId ?? '?')} workspace=${String(workspace.workspaceId ?? '?')}${result.error ? ` error=${String(result.error)}` : ''}`);
  }
}

function renderList(value: unknown, json: boolean): void {
  if (json) return printJson(value);
  const rows = Array.isArray(value) ? value : [];
  if (rows.length === 0) return console.log('No managed workspaces found.');
  for (const row of rows) renderWorkspace(row, false);
}

function renderInspect(value: unknown, json: boolean): void {
  if (json) return printJson(value);
  const detail = asRecord(value);
  renderWorkspace(detail.workspace, false);
  for (const event of Array.isArray(detail.events) ? detail.events : []) {
    const record = asRecord(event);
    console.log(`  ${String(record.createdAt ?? '')} ${String(record.eventType ?? '?')} artifact=${String(record.artifactId ?? '-')}`);
  }
}

function renderWorkspace(value: unknown, json: boolean): void {
  if (json) return printJson(value);
  const workspace = asRecord(value);
  console.log(`${String(workspace.workspaceId ?? '?')} ${String(workspace.status ?? '?')} graph=${String(workspace.graphId ?? '?')} task=${String(workspace.taskId ?? '?')} backup=${String(workspace.backupArtifactId ?? '-')}`);
}

function printWorkspacesHelp(): void {
  console.log(`los workspaces

Usage:
  los workspaces plan GRAPH_ID [--project PROJECT_ID]
  los workspaces apply GRAPH_ID [--project PROJECT_ID] [--tasks TASK_A,TASK_B]
  los workspaces list [--graph ID] [--task ID] [--project ID] [--status STATUS]
  los workspaces inspect WORKSPACE_ID
  los workspaces backup WORKSPACE_ID
  los workspaces release WORKSPACE_ID --confirm WORKSPACE_ID

Mutating commands require LOS_OPERATOR_TOKEN. Release always creates an
artifact-backed diff before forgetting and removing the managed jj workspace.`);
}

function parseArgs(argv: string[]): ParsedArgs {
  const flags: Record<string, string | boolean> = {};
  const positionals: string[] = [];
  const booleanFlags = new Set(['help', 'h', 'json']);
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token.startsWith('--')) {
      const [key, inline] = token.slice(2).split('=', 2);
      if (inline !== undefined) flags[key] = inline;
      else if (booleanFlags.has(key)) flags[key] = true;
      else if (argv[i + 1] && !argv[i + 1].startsWith('-')) flags[key] = argv[++i];
      else flags[key] = true;
    } else if (token === '-h') flags.help = true;
    else positionals.push(token);
  }
  return { flags, positionals };
}

function mergeParsed(left: ParsedArgs, right: ParsedArgs): ParsedArgs { return { flags: { ...left.flags, ...right.flags }, positionals: [...left.positionals, ...right.positionals] }; }
function gatewayUrl(parsed: ParsedArgs): string { return (stringFlag(parsed, 'gateway') ?? process.env.LOS_GATEWAY_URL ?? process.env.LOS_SERVER_URL ?? DEFAULT_GATEWAY).replace(/\/+$/, ''); }
function stringFlag(parsed: ParsedArgs, key: string): string | undefined { const value = parsed.flags[key]; return typeof value === 'string' && value.trim() ? value.trim() : undefined; }
function booleanFlag(parsed: ParsedArgs, key: string): boolean { return parsed.flags[key] === true || parsed.flags[key] === 'true'; }
function hasFlag(parsed: ParsedArgs, ...keys: string[]): boolean { return keys.some(key => parsed.flags[key] !== undefined); }
function requirePosition(parsed: ParsedArgs, index: number, label: string): string { const value = parsed.positionals[index]; if (!value) throw new Error(`${label} is required`); return value; }
function commaList(value: string | undefined): string[] { return value ? [...new Set(value.split(',').map(item => item.trim()).filter(Boolean))] : []; }
function asRecord(value: unknown): JsonRecord { return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {}; }
function array(value: unknown, key: string): unknown[] { const root = asRecord(value); return Array.isArray(root[key]) ? root[key] as unknown[] : []; }
function printJson(value: unknown): void { console.log(JSON.stringify(value)); }
