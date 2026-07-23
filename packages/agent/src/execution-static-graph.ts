import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, relative, sep } from 'node:path';
import { js, jsx, ts, tsx, type SgNode } from '@ast-grep/napi';

export type ExecutionStaticNodeKind =
  | 'cli_command'
  | 'gateway_route'
  | 'agent_export'
  | 'function'
  | 'executor_endpoint'
  | 'runtime_state'
  | 'provider'
  | 'tool_runtime';

export interface ExecutionStaticNode {
  id: string;
  kind: ExecutionStaticNodeKind;
  label: string;
  file?: string;
  line?: number;
  method?: string;
  path?: string;
  command?: string;
  exportName?: string;
}

export type ExecutionStaticEdgeKind =
  | 'dispatches_to'
  | 'calls'
  | 'posts_to'
  | 'handled_by'
  | 'chooses_path'
  | 'streams'
  | 'persists'
  | 'exports';

export interface ExecutionStaticEdge {
  from: string;
  to: string;
  kind: ExecutionStaticEdgeKind;
  label?: string;
}

export interface ExecutionStaticGraph {
  nodes: ExecutionStaticNode[];
  edges: ExecutionStaticEdge[];
  warnings: string[];
}

export interface BuildExecutionStaticGraphOptions {
  workspaceRoot: string;
}

type LangKey = 'ts' | 'tsx' | 'js' | 'jsx';

const LANGS: Record<LangKey, { parse: (src: string) => { root: () => SgNode } }> = { ts, tsx, js, jsx };
const LANG_BY_EXT: Record<string, LangKey> = {
  '.ts': 'ts',
  '.tsx': 'tsx',
  '.js': 'js',
  '.jsx': 'jsx',
  '.mts': 'ts',
  '.mjs': 'js',
};

const CORE_FUNCTION_FILES: Record<string, string> = {
  chatCommand: 'packages/cli/src/index.ts',
  registerChatRoute: 'packages/gateway/src/chat-route.ts',
  createRunSpec: 'packages/agent/src/run-specs.ts',
  runScheduledAgentTask: 'packages/agent/src/scheduler/scheduled-task-runner.ts',
  resolveExecutor: 'packages/agent/src/scheduler/executor-client.ts',
  runAgentOnExecutor: 'packages/agent/src/scheduler/executor-client.ts',
  resolveExecutionKernel: 'packages/agent/src/execution-kernel-registry.ts',
  runLosExecutionKernel: 'packages/agent/src/execution-kernel.ts',
  runAgent: 'packages/agent/src/loop.ts',
  createLosToolBroker: 'packages/agent/src/los-tool-broker.ts',
  runAssignedAgentTask: 'packages/executor/src/index.ts',
};

const CORE_EDGES: ExecutionStaticEdge[] = [
  { from: 'cli-command:chat', to: 'function:chatCommand', kind: 'dispatches_to' },
  { from: 'cli-command:run', to: 'function:chatCommand', kind: 'dispatches_to' },
  { from: 'function:chatCommand', to: 'gateway-route:POST /chat', kind: 'posts_to' },
  { from: 'gateway-route:POST /chat', to: 'function:registerChatRoute', kind: 'handled_by' },
  { from: 'function:registerChatRoute', to: 'function:createRunSpec', kind: 'calls' },
  { from: 'function:registerChatRoute', to: 'function:runScheduledAgentTask', kind: 'calls' },
  { from: 'function:runScheduledAgentTask', to: 'function:resolveExecutor', kind: 'calls' },
  { from: 'function:runScheduledAgentTask', to: 'function:runAgentOnExecutor', kind: 'chooses_path', label: 'executor path' },
  { from: 'function:runScheduledAgentTask', to: 'function:resolveExecutionKernel', kind: 'calls', label: 'fail-closed kernel selection' },
  { from: 'function:resolveExecutionKernel', to: 'function:runLosExecutionKernel', kind: 'chooses_path', label: 'LOS adapter' },
  { from: 'function:runScheduledAgentTask', to: 'runtime-state:session_events', kind: 'persists', label: 'canonical kernel events' },
  { from: 'function:runLosExecutionKernel', to: 'function:runAgent', kind: 'calls', label: 'LOS adapter' },
  { from: 'function:runAgentOnExecutor', to: 'executor-endpoint:POST /v1/tasks/run-agent', kind: 'posts_to' },
  { from: 'executor-endpoint:POST /v1/tasks/run-agent', to: 'function:runAssignedAgentTask', kind: 'handled_by' },
  { from: 'function:runAssignedAgentTask', to: 'function:resolveExecutionKernel', kind: 'calls' },
  { from: 'function:runAgent', to: 'provider:chat', kind: 'calls' },
  { from: 'function:runAgent', to: 'function:createLosToolBroker', kind: 'calls' },
  { from: 'function:createLosToolBroker', to: 'tool-runtime:execute', kind: 'calls', label: 'governed broker' },
  { from: 'function:runAgent', to: 'runtime-state:session_events', kind: 'persists' },
  { from: 'function:runScheduledAgentTask', to: 'runtime-state:task_runs', kind: 'persists' },
  { from: 'function:runScheduledAgentTask', to: 'runtime-state:tool_call_states', kind: 'persists' },
];

export function buildExecutionStaticGraph(options: BuildExecutionStaticGraphOptions): ExecutionStaticGraph {
  const graph = createGraphBuilder();
  const root = options.workspaceRoot;

  extractCliCommands(root, graph);
  extractGatewayRoutes(root, graph);
  extractAgentExports(root, graph);
  extractCoreFunctions(root, graph);
  addRuntimeNodes(graph);
  for (const edge of CORE_EDGES) graph.addEdge(edge);

  return graph.toGraph();
}

function extractCliCommands(root: string, graph: GraphBuilder): void {
  const file = 'packages/cli/src/index.ts';
  const parsed = parseWorkspaceFile(root, file, graph);
  if (!parsed) return;

  const commandNames = new Map<string, number>();
  for (const node of parsed.root.findAll({ rule: { kind: 'binary_expression' } })) {
    const text = node.text();
    for (const match of text.matchAll(/\bcommand\s*===\s*['"]([^'"]+)['"]/g)) {
      const command = match[1];
      if (!command || command.startsWith('-')) continue;
      const line = node.range().start.line + 1;
      commandNames.set(command, Math.min(commandNames.get(command) ?? line, line));
    }
  }

  for (const [command, line] of commandNames) {
    graph.addNode({
      id: `cli-command:${command}`,
      kind: 'cli_command',
      label: command,
      command,
      file,
      line,
    });
  }
}

function extractGatewayRoutes(root: string, graph: GraphBuilder): void {
  const gatewayRoot = join(root, 'packages/gateway/src');
  if (!existsSync(gatewayRoot)) {
    graph.warn(`missing gateway source directory: ${toWorkspacePath(root, gatewayRoot)}`);
    return;
  }

  for (const file of listSourceFiles(gatewayRoot).map(path => toWorkspacePath(root, path))) {
    const parsed = parseWorkspaceFile(root, file, graph);
    if (!parsed) continue;

    for (const node of parsed.root.findAll({ rule: { kind: 'call_expression' } })) {
      const match = node.text().match(/\bapp\.(get|post|put|patch|delete)\(\s*['"`]([^'"`]+)['"`]/);
      if (!match) continue;
      const method = match[1].toUpperCase();
      const path = match[2];
      graph.addNode({
        id: `gateway-route:${method} ${path}`,
        kind: 'gateway_route',
        label: `${method} ${path}`,
        method,
        path,
        file,
        line: node.range().start.line + 1,
      });
    }
  }
}

function extractAgentExports(root: string, graph: GraphBuilder): void {
  const file = 'packages/agent/src/index.ts';
  const parsed = parseWorkspaceFile(root, file, graph);
  if (!parsed) return;

  for (const node of parsed.root.findAll({ rule: { kind: 'export_statement' } })) {
    const exportBlock = node.text().match(/export\s*\{([\s\S]*?)\}\s*from\s*['"][^'"]+['"]/);
    if (!exportBlock) continue;
    for (const rawName of exportBlock[1].split(',')) {
      const name = rawName.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0]?.trim();
      if (!name || name === 'type') continue;
      graph.addNode({
        id: `agent-export:${name}`,
        kind: 'agent_export',
        label: name,
        exportName: name,
        file,
        line: node.range().start.line + 1,
      });
      graph.addEdge({
        from: 'agent-entrypoint:@los/agent',
        to: `agent-export:${name}`,
        kind: 'exports',
      });
    }
  }
}

function extractCoreFunctions(root: string, graph: GraphBuilder): void {
  for (const [name, file] of Object.entries(CORE_FUNCTION_FILES)) {
    const parsed = parseWorkspaceFile(root, file, graph);
    if (!parsed) continue;
    const node = findFunctionLikeNode(parsed.root, name);
    graph.addNode({
      id: `function:${name}`,
      kind: 'function',
      label: name,
      file,
      line: node ? node.range().start.line + 1 : undefined,
    });
    if (!node) graph.warn(`core function not found by AST: ${name} in ${file}`);
  }
}

function addRuntimeNodes(graph: GraphBuilder): void {
  graph.addNode({ id: 'agent-entrypoint:@los/agent', kind: 'agent_export', label: '@los/agent' });
  graph.addNode({
    id: 'executor-endpoint:POST /v1/tasks/run-agent',
    kind: 'executor_endpoint',
    label: 'POST /v1/tasks/run-agent',
    method: 'POST',
    path: '/v1/tasks/run-agent',
    file: 'packages/executor/src/index.ts',
  });
  graph.addNode({ id: 'provider:chat', kind: 'provider', label: 'provider.chat' });
  graph.addNode({ id: 'tool-runtime:execute', kind: 'tool_runtime', label: 'tools.execute' });
  graph.addNode({ id: 'runtime-state:run_specs', kind: 'runtime_state', label: 'run_specs' });
  graph.addNode({ id: 'runtime-state:task_runs', kind: 'runtime_state', label: 'task_runs' });
  graph.addNode({ id: 'runtime-state:session_events', kind: 'runtime_state', label: 'session_events' });
  graph.addNode({ id: 'runtime-state:tool_call_states', kind: 'runtime_state', label: 'tool_call_states' });
}

function findFunctionLikeNode(root: SgNode, name: string): SgNode | null {
  const functionKinds = [
    'function_declaration',
    'generator_function_declaration',
    'method_definition',
    'variable_declarator',
  ];
  for (const kind of functionKinds) {
    for (const node of root.findAll({ rule: { kind } })) {
      const identifier = node.find({ rule: { kind: 'identifier' } });
      if (identifier?.text() === name) return node;
    }
  }
  return null;
}

function parseWorkspaceFile(root: string, file: string, graph: GraphBuilder): { root: SgNode } | null {
  const fullPath = join(root, file);
  const lang = LANG_BY_EXT[extname(fullPath).toLowerCase()];
  if (!lang) {
    graph.warn(`unsupported source file extension: ${file}`);
    return null;
  }
  if (!existsSync(fullPath)) {
    graph.warn(`missing source file: ${file}`);
    return null;
  }
  try {
    return { root: LANGS[lang].parse(readFileSync(fullPath, 'utf8')).root() };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    graph.warn(`failed to parse ${file}: ${message}`);
    return null;
  }
}

function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const fullPath = join(dir, entry);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      out.push(...listSourceFiles(fullPath));
      continue;
    }
    if (/\.(ts|tsx|js|jsx|mts|mjs)$/.test(entry) && !entry.endsWith('.d.ts')) {
      out.push(fullPath);
    }
  }
  return out.sort();
}

function toWorkspacePath(root: string, path: string): string {
  return relative(root, path).split(sep).join('/');
}

interface GraphBuilder {
  addNode(node: ExecutionStaticNode): void;
  addEdge(edge: ExecutionStaticEdge): void;
  warn(message: string): void;
  toGraph(): ExecutionStaticGraph;
}

function createGraphBuilder(): GraphBuilder {
  const nodes = new Map<string, ExecutionStaticNode>();
  const edges = new Map<string, ExecutionStaticEdge>();
  const warnings: string[] = [];

  return {
    addNode(node) {
      const existing = nodes.get(node.id);
      nodes.set(node.id, existing ? { ...node, ...existing } : node);
    },
    addEdge(edge) {
      edges.set(`${edge.from}->${edge.to}:${edge.kind}:${edge.label ?? ''}`, edge);
    },
    warn(message) {
      warnings.push(message);
    },
    toGraph() {
      return {
        nodes: [...nodes.values()].sort((a, b) => a.id.localeCompare(b.id)),
        edges: [...edges.values()].sort((a, b) => (
          a.from.localeCompare(b.from)
          || a.to.localeCompare(b.to)
          || a.kind.localeCompare(b.kind)
          || (a.label ?? '').localeCompare(b.label ?? '')
        )),
        warnings,
      };
    },
  };
}
