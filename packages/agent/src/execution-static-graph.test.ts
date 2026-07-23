import assert from 'node:assert/strict';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { buildExecutionStaticGraph } from './execution-static-graph.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

test('buildExecutionStaticGraph extracts core execution entrypoints', () => {
  const graph = buildExecutionStaticGraph({ workspaceRoot: repoRoot });
  const nodeIds = new Set(graph.nodes.map(node => node.id));

  assert.deepEqual(graph.warnings, []);
  assert.ok(nodeIds.has('cli-command:chat'));
  assert.ok(nodeIds.has('cli-command:run'));
  assert.ok(nodeIds.has('gateway-route:POST /chat'));
  assert.ok(nodeIds.has('gateway-route:GET /agent-graphs/:id'));
  assert.ok(nodeIds.has('gateway-route:GET /agent-graphs/:id/completion'));
  assert.ok(nodeIds.has('agent-export:runAgent'));
  assert.ok(nodeIds.has('agent-export:runScheduledAgentTask'));
  assert.ok(nodeIds.has('agent-export:claimReadyAgentTasks'));
  assert.ok(nodeIds.has('function:runAgent'));
  assert.ok(nodeIds.has('function:runLosExecutionKernel'));
  assert.ok(nodeIds.has('function:resolveExecutionKernel'));
  assert.ok(nodeIds.has('function:runScheduledAgentTask'));
  assert.ok(nodeIds.has('function:createLosToolBroker'));
  assert.ok(nodeIds.has('runtime-state:session_events'));
  assert.ok(nodeIds.has('runtime-state:tool_call_states'));
});

test('buildExecutionStaticGraph records the minimal chat execution call chain', () => {
  const graph = buildExecutionStaticGraph({ workspaceRoot: repoRoot });

  assertEdge(graph, 'cli-command:chat', 'function:chatCommand', 'dispatches_to');
  assertEdge(graph, 'cli-command:run', 'function:chatCommand', 'dispatches_to');
  assertEdge(graph, 'function:chatCommand', 'gateway-route:POST /chat', 'posts_to');
  assertEdge(graph, 'gateway-route:POST /chat', 'function:registerChatRoute', 'handled_by');
  assertEdge(graph, 'function:registerChatRoute', 'function:createRunSpec', 'calls');
  assertEdge(graph, 'function:registerChatRoute', 'function:runScheduledAgentTask', 'calls');
  assertEdge(graph, 'function:runScheduledAgentTask', 'function:resolveExecutionKernel', 'calls');
  assertEdge(graph, 'function:resolveExecutionKernel', 'function:runLosExecutionKernel', 'chooses_path');
  assertEdge(graph, 'function:runScheduledAgentTask', 'runtime-state:session_events', 'persists');
  assertEdge(graph, 'function:runLosExecutionKernel', 'function:runAgent', 'calls');
  assertEdge(graph, 'function:runAgentOnExecutor', 'executor-endpoint:POST /v1/tasks/run-agent', 'posts_to');
  assertEdge(graph, 'executor-endpoint:POST /v1/tasks/run-agent', 'function:runAssignedAgentTask', 'handled_by');
  assertEdge(graph, 'function:runAssignedAgentTask', 'function:resolveExecutionKernel', 'calls');
  assertEdge(graph, 'function:runAgent', 'provider:chat', 'calls');
  assertEdge(graph, 'function:runAgent', 'function:createLosToolBroker', 'calls');
  assertEdge(graph, 'function:createLosToolBroker', 'tool-runtime:execute', 'calls');
  assertEdge(graph, 'function:runAgent', 'runtime-state:session_events', 'persists');
  assertEdge(graph, 'function:runScheduledAgentTask', 'runtime-state:tool_call_states', 'persists');
});

function assertEdge(
  graph: ReturnType<typeof buildExecutionStaticGraph>,
  from: string,
  to: string,
  kind: string,
): void {
  assert.ok(
    graph.edges.some(edge => edge.from === from && edge.to === to && edge.kind === kind),
    `missing edge ${from} -[${kind}]-> ${to}`,
  );
}
