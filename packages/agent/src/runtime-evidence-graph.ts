import {
  listAgentTaskAttempts,
  listAgentTaskEdgesForGraph,
  listAgentTasksForRunSpec,
  type AgentTaskAttemptRecord,
  type AgentTaskRecord,
} from './agent-task-graph.js';
import { loadRunSpec, type RunSpecRecord } from './run-specs.js';
import { listSessionEvents, type SessionEventRecord } from './session-events.js';
import { listTaskRunsForRunSpec, type TaskRunRecord } from './task-runs.js';
import { listToolCallStatesForRunSpec, type ToolCallStateRecord } from './tool-call-states.js';
import { listVerificationRecordsForRunSpec, type VerificationRecord } from './verification-records.js';

export type RuntimeEvidenceNodeKind =
  | 'run_spec'
  | 'task_run'
  | 'session_event'
  | 'tool_call_state'
  | 'verification_record'
  | 'agent_task'
  | 'task_attempt';

export type RuntimeEvidenceEdgeKind =
  | 'has_task_run'
  | 'has_session_event'
  | 'has_tool_call_state'
  | 'has_verification_record'
  | 'has_agent_task'
  | 'has_task_attempt'
  | 'emitted_event'
  | 'depends_on'
  | 'attempt_ran_as'
  | 'attempt_verified_by'
  | 'attempt_used_tool_state'
  | 'parent_event';

export type RuntimeEvidenceRecord =
  | RunSpecRecord
  | TaskRunRecord
  | SessionEventRecord
  | ToolCallStateRecord
  | VerificationRecord
  | AgentTaskRecord
  | AgentTaskAttemptRecord;

export interface RuntimeEvidenceNode {
  id: string;
  kind: RuntimeEvidenceNodeKind;
  label: string;
  recordId: string;
  record: RuntimeEvidenceRecord;
}

export interface RuntimeEvidenceEdge {
  from: string;
  to: string;
  kind: RuntimeEvidenceEdgeKind;
  label?: string;
}

export interface RuntimeEvidenceGraph {
  runSpecId: string;
  sessionId: string;
  nodes: RuntimeEvidenceNode[];
  edges: RuntimeEvidenceEdge[];
  counts: Record<RuntimeEvidenceNodeKind, number>;
  warnings: string[];
}

export interface ReadRuntimeEvidenceGraphOptions {
  sessionEventLimit?: number;
  toolCallStateLimit?: number;
}

export async function readRuntimeEvidenceGraph(
  runSpecId: string,
  options: ReadRuntimeEvidenceGraphOptions = {},
): Promise<RuntimeEvidenceGraph | null> {
  const runSpec = await loadRunSpec(runSpecId);
  if (!runSpec) return null;

  const sessionEventLimit = boundedLimit(options.sessionEventLimit, 1000);
  const toolCallStateLimit = boundedLimit(options.toolCallStateLimit, 1000);
  const [taskRuns, sessionEvents, toolStates, verificationRecords, agentTasks] = await Promise.all([
    listTaskRunsForRunSpec(runSpec.id),
    listSessionEvents(runSpec.sessionId, sessionEventLimit),
    listToolCallStatesForRunSpec(runSpec.id, toolCallStateLimit),
    listVerificationRecordsForRunSpec(runSpec.id),
    listAgentTasksForRunSpec(runSpec.id),
  ]);

  const graphIds = unique(agentTasks.map(task => task.graphId));
  const [edgesByGraph, attemptsByTask] = await Promise.all([
    Promise.all(graphIds.map(async graphId => [graphId, await listAgentTaskEdgesForGraph(graphId)] as const)),
    Promise.all(agentTasks.map(async task => [task.id, await listAgentTaskAttempts(task.id)] as const)),
  ]);

  const builder = createRuntimeEvidenceGraphBuilder(runSpec.id, runSpec.sessionId);
  builder.addNode(runSpecNode(runSpec));

  const taskRunNodeIds = new Map<string, string>();
  const toolStateNodeIds = new Map<string, string>();
  const verificationNodeIds = new Map<string, string>();
  const agentTaskNodeIds = new Map<string, string>();
  const eventNodeIds = new Map<number, string>();

  for (const taskRun of taskRuns) {
    const node = taskRunNode(taskRun);
    taskRunNodeIds.set(taskRun.id, node.id);
    builder.addNode(node);
    builder.addEdge({ from: runSpecNodeId(runSpec.id), to: node.id, kind: 'has_task_run' });
  }

  for (const event of sessionEvents) {
    const node = sessionEventNode(event);
    eventNodeIds.set(event.id, node.id);
    builder.addNode(node);
    builder.addEdge({ from: runSpecNodeId(runSpec.id), to: node.id, kind: 'has_session_event' });

    const taskRunId = normalizeString(event.payload.taskRunId);
    const taskRunNodeId = taskRunId ? taskRunNodeIds.get(taskRunId) : undefined;
    if (taskRunNodeId) builder.addEdge({ from: taskRunNodeId, to: node.id, kind: 'emitted_event' });
  }

  for (const event of sessionEvents) {
    if (!event.parentEventId) continue;
    const parent = eventNodeIds.get(event.parentEventId);
    const child = eventNodeIds.get(event.id);
    if (parent && child) builder.addEdge({ from: parent, to: child, kind: 'parent_event' });
  }

  for (const toolState of toolStates) {
    const node = toolCallStateNode(toolState);
    toolStateNodeIds.set(toolState.id, node.id);
    builder.addNode(node);
    builder.addEdge({ from: runSpecNodeId(runSpec.id), to: node.id, kind: 'has_tool_call_state' });
    if (toolState.taskRunId) {
      const taskRunNodeId = taskRunNodeIds.get(toolState.taskRunId);
      if (taskRunNodeId) builder.addEdge({ from: taskRunNodeId, to: node.id, kind: 'has_tool_call_state' });
    }
  }

  for (const verification of verificationRecords) {
    const node = verificationRecordNode(verification);
    verificationNodeIds.set(verification.id, node.id);
    builder.addNode(node);
    builder.addEdge({ from: runSpecNodeId(runSpec.id), to: node.id, kind: 'has_verification_record' });
    if (verification.taskRunId) {
      const taskRunNodeId = taskRunNodeIds.get(verification.taskRunId);
      if (taskRunNodeId) builder.addEdge({ from: taskRunNodeId, to: node.id, kind: 'has_verification_record' });
    }
  }

  for (const task of agentTasks) {
    const node = agentTaskNode(task);
    agentTaskNodeIds.set(task.id, node.id);
    builder.addNode(node);
    builder.addEdge({ from: runSpecNodeId(runSpec.id), to: node.id, kind: 'has_agent_task' });
  }

  for (const [, graphEdges] of edgesByGraph) {
    for (const edge of graphEdges) {
      const from = agentTaskNodeIds.get(edge.dependsOnTaskId);
      const to = agentTaskNodeIds.get(edge.taskId);
      if (from && to) builder.addEdge({ from, to, kind: 'depends_on', label: edge.kind });
    }
  }

  for (const [, attempts] of attemptsByTask) {
    for (const attempt of attempts) {
      const node = taskAttemptNode(attempt);
      builder.addNode(node);
      const taskNodeId = agentTaskNodeIds.get(attempt.taskId);
      if (taskNodeId) builder.addEdge({ from: taskNodeId, to: node.id, kind: 'has_task_attempt' });
      if (attempt.taskRunId) {
        const taskRunNodeId = taskRunNodeIds.get(attempt.taskRunId);
        if (taskRunNodeId) builder.addEdge({ from: node.id, to: taskRunNodeId, kind: 'attempt_ran_as' });
      }
      if (attempt.verificationRecordId) {
        const verificationNodeId = verificationNodeIds.get(attempt.verificationRecordId);
        if (verificationNodeId) builder.addEdge({ from: node.id, to: verificationNodeId, kind: 'attempt_verified_by' });
      }
      for (const toolCallStateId of attempt.toolCallStateIds) {
        const toolStateNodeId = toolStateNodeIds.get(toolCallStateId);
        if (toolStateNodeId) builder.addEdge({ from: node.id, to: toolStateNodeId, kind: 'attempt_used_tool_state' });
      }
    }
  }

  if (sessionEvents.length >= sessionEventLimit) {
    builder.warn(`session event evidence may be truncated at limit=${sessionEventLimit}`);
  }
  if (toolStates.length >= toolCallStateLimit) {
    builder.warn(`tool call state evidence may be truncated at limit=${toolCallStateLimit}`);
  }

  return builder.toGraph();
}

function createRuntimeEvidenceGraphBuilder(runSpecId: string, sessionId: string) {
  const nodes = new Map<string, RuntimeEvidenceNode>();
  const edges = new Map<string, RuntimeEvidenceEdge>();
  const warnings: string[] = [];
  return {
    addNode(node: RuntimeEvidenceNode): void {
      nodes.set(node.id, node);
    },
    addEdge(edge: RuntimeEvidenceEdge): void {
      edges.set(`${edge.from}|${edge.kind}|${edge.to}|${edge.label ?? ''}`, edge);
    },
    warn(message: string): void {
      warnings.push(message);
    },
    toGraph(): RuntimeEvidenceGraph {
      const outNodes = [...nodes.values()];
      return {
        runSpecId,
        sessionId,
        nodes: outNodes,
        edges: [...edges.values()],
        counts: countNodes(outNodes),
        warnings,
      };
    },
  };
}

function runSpecNode(record: RunSpecRecord): RuntimeEvidenceNode {
  return {
    id: runSpecNodeId(record.id),
    kind: 'run_spec',
    label: record.id,
    recordId: record.id,
    record,
  };
}

function taskRunNode(record: TaskRunRecord): RuntimeEvidenceNode {
  return {
    id: taskRunNodeId(record.id),
    kind: 'task_run',
    label: `${record.status} ${record.id}`,
    recordId: record.id,
    record,
  };
}

function sessionEventNode(record: SessionEventRecord): RuntimeEvidenceNode {
  return {
    id: sessionEventNodeId(record.id),
    kind: 'session_event',
    label: `${record.id} ${record.type}`,
    recordId: String(record.id),
    record,
  };
}

function toolCallStateNode(record: ToolCallStateRecord): RuntimeEvidenceNode {
  return {
    id: toolCallStateNodeId(record.sessionId, record.id),
    kind: 'tool_call_state',
    label: `${record.state} ${record.toolName}`,
    recordId: record.id,
    record,
  };
}

function verificationRecordNode(record: VerificationRecord): RuntimeEvidenceNode {
  return {
    id: verificationRecordNodeId(record.id),
    kind: 'verification_record',
    label: `${record.status} ${record.checkName}`,
    recordId: record.id,
    record,
  };
}

function agentTaskNode(record: AgentTaskRecord): RuntimeEvidenceNode {
  return {
    id: agentTaskNodeId(record.id),
    kind: 'agent_task',
    label: `${record.role} ${record.title}`,
    recordId: record.id,
    record,
  };
}

function taskAttemptNode(record: AgentTaskAttemptRecord): RuntimeEvidenceNode {
  return {
    id: taskAttemptNodeId(record.id),
    kind: 'task_attempt',
    label: `${record.status} attempt ${record.attempt}`,
    recordId: record.id,
    record,
  };
}

function runSpecNodeId(id: string): string {
  return `run_spec:${id}`;
}

function taskRunNodeId(id: string): string {
  return `task_run:${id}`;
}

function sessionEventNodeId(id: number): string {
  return `session_event:${id}`;
}

function toolCallStateNodeId(sessionId: string, id: string): string {
  return `tool_call_state:${sessionId}:${id}`;
}

function verificationRecordNodeId(id: string): string {
  return `verification_record:${id}`;
}

function agentTaskNodeId(id: string): string {
  return `agent_task:${id}`;
}

function taskAttemptNodeId(id: string): string {
  return `task_attempt:${id}`;
}

function countNodes(nodes: readonly RuntimeEvidenceNode[]): Record<RuntimeEvidenceNodeKind, number> {
  return {
    run_spec: nodes.filter(node => node.kind === 'run_spec').length,
    task_run: nodes.filter(node => node.kind === 'task_run').length,
    session_event: nodes.filter(node => node.kind === 'session_event').length,
    tool_call_state: nodes.filter(node => node.kind === 'tool_call_state').length,
    verification_record: nodes.filter(node => node.kind === 'verification_record').length,
    agent_task: nodes.filter(node => node.kind === 'agent_task').length,
    task_attempt: nodes.filter(node => node.kind === 'task_attempt').length,
  };
}

function boundedLimit(value: number | undefined, defaultValue: number): number {
  if (!Number.isFinite(value)) return defaultValue;
  return Math.max(1, Math.min(10_000, Math.floor(value ?? defaultValue)));
}

function normalizeString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}
