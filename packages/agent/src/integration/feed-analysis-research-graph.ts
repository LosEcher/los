import { createAgentTask, linkAgentTaskDependency } from '../agent-task-graph.js';
import {
  runAgentTaskGraphSerial,
  type AgentTaskGraphStageOutput,
  type ScheduledExecutorConfig,
  type ScheduledTaskEvent,
} from '../scheduler.js';
import { FeedAnalysisError } from './feed-analysis-types.js';
import {
  buildFeedAnalysisWorkflowPrompt,
  type PreparedFeedAnalysisInput,
} from './feed-analysis-workflow.js';

interface ResearchGraphStage {
  key: string;
  title: string;
  instruction: string;
}

const RESEARCH_STAGES: ResearchGraphStage[] = [
  {
    key: 'planner',
    title: 'Plan topic research',
    instruction: 'Create a concise research plan: core questions, evidence groups, conflicts to resolve, and expected output sections.',
  },
  {
    key: 'analyst',
    title: 'Analyze locked evidence',
    instruction: 'Analyze the locked evidence against the research plan. Separate supported claims, contradictions, weak signals, and missing context.',
  },
  {
    key: 'synthesis',
    title: 'Synthesize topic findings',
    instruction: 'Synthesize the strongest findings into a coherent topic narrative. Preserve uncertainty and citation traceability.',
  },
  {
    key: 'writer',
    title: 'Draft requested topic artifacts',
    instruction: 'Draft the requested digest, brief, and platform content using only supported claims. This is an intermediate draft for verification.',
  },
  {
    key: 'verifier',
    title: 'Verify and finalize topic artifacts',
    instruction: 'Verify claim support, citation references, requested artifact coverage, and platform fields. Return the corrected final result JSON.',
  },
];

export interface FeedAnalysisResearchGraphInput {
  dispatchId: string;
  runSpecId: string;
  sessionId: string;
  traceId: string;
  workspaceRoot: string;
  tenantId: string;
  projectId: string;
  userId?: string;
  requestId?: string;
  provider?: string;
  model?: string;
  timeoutMs?: number;
  executor?: ScheduledExecutorConfig;
  prepared: PreparedFeedAnalysisInput;
  onTaskEvent?: (event: ScheduledTaskEvent) => void | Promise<void>;
}

export interface FeedAnalysisResearchGraphResult {
  text: string;
  provider?: string;
  model?: string;
  promptTokens: number;
  completionTokens: number;
}

export async function runFeedAnalysisResearchGraph(
  input: FeedAnalysisResearchGraphInput,
): Promise<FeedAnalysisResearchGraphResult> {
  const graphId = `feed-analysis-research:${input.dispatchId}`;
  await createResearchGraph(graphId, input);
  const result = await runAgentTaskGraphSerial({
    graphId,
    sessionId: input.sessionId,
    traceId: input.traceId,
    workspaceRoot: input.workspaceRoot,
    tenantId: input.tenantId,
    projectId: input.projectId,
    userId: input.userId,
    requestId: input.requestId,
    provider: input.provider,
    model: input.model,
    timeoutMs: input.timeoutMs,
    executor: input.executor,
    toolMode: 'read-only',
    allowedTools: [],
    maxLoops: input.prepared.workflow.maxLoops,
    maxTasks: RESEARCH_STAGES.length,
    maxParallelTasks: 1,
    metadata: {
      feedAnalysisDispatchId: input.dispatchId,
      scenario: input.prepared.workflow.scenario,
      workflowProfile: input.prepared.workflow.profile,
    },
    runContract: {
      mode: 'feed-analysis-ingress',
      executionMode: input.prepared.workflow.executionMode,
    },
    onTaskEvent: input.onTaskEvent,
    resolveTaskPrompt: (task, completedStages) => buildResearchStagePrompt(task.id, input.prepared, completedStages),
  });

  if (result.completion.status !== 'succeeded') {
    throw new FeedAnalysisError(
      'workflow_incomplete',
      result.completion.reason ?? `research graph ended with ${result.completion.status}`,
      422,
    );
  }
  const outputs = result.executedTasks
    .map(task => task.stageOutput)
    .filter((stage): stage is AgentTaskGraphStageOutput => Boolean(stage));
  const final = outputs.at(-1);
  if (!final?.outputText.trim()) {
    throw new FeedAnalysisError('workflow_incomplete', 'research graph produced no final output', 422);
  }
  return {
    text: final.outputText,
    provider: final.provider,
    model: final.model,
    promptTokens: outputs.reduce((sum, stage) => sum + stage.promptTokens, 0),
    completionTokens: outputs.reduce((sum, stage) => sum + stage.completionTokens, 0),
  };
}

async function createResearchGraph(graphId: string, input: FeedAnalysisResearchGraphInput): Promise<void> {
  for (const [index, stage] of RESEARCH_STAGES.entries()) {
    const taskId = `${graphId}:${stage.key}`;
    await createAgentTask({
      id: taskId,
      graphId,
      runSpecId: input.runSpecId,
      sessionId: input.sessionId,
      role: index === 0 ? 'planner' : 'executor',
      title: stage.title,
      prompt: stage.instruction,
      priority: (index + 1) * 10,
      metadata: {
        feedAnalysisDispatchId: input.dispatchId,
        researchStage: stage.key,
        workflowProfile: input.prepared.workflow.profile,
      },
    });
    if (index > 0) {
      await linkAgentTaskDependency({
        graphId,
        taskId,
        dependsOnTaskId: `${graphId}:${RESEARCH_STAGES[index - 1]!.key}`,
      });
    }
  }
}

function buildResearchStagePrompt(
  taskId: string,
  prepared: PreparedFeedAnalysisInput,
  completedStages: readonly AgentTaskGraphStageOutput[],
): string {
  const stage = RESEARCH_STAGES.find(candidate => taskId.endsWith(`:${candidate.key}`));
  if (!stage) throw new FeedAnalysisError('workflow_incomplete', `unknown research stage ${taskId}`, 422);
  const prior = completedStages.map(output => ({
    stage: output.title,
    output: truncate(output.outputText, 8_000),
  }));
  if (stage.key === 'verifier') {
    return [
      buildFeedAnalysisWorkflowPrompt(prepared),
      `Final verification instruction: ${stage.instruction}`,
      `Prior stage outputs: ${JSON.stringify(prior)}`,
    ].join('\n');
  }
  return [
    `You are executing the ${stage.key} stage of ${prepared.workflow.workflowId}@${prepared.workflow.workflowVersion}.`,
    stage.instruction,
    'Use only the locked material and prior stage outputs supplied below. Workspace and external tools are disabled.',
    'Return concise structured prose or JSON for the next stage. Do not claim publication and do not invent sources.',
    JSON.stringify({
      topic: prepared.topic,
      collectionSnapshot: prepared.collectionSnapshot,
      requestedOutputs: prepared.requestedOutputs,
      policy: prepared.policy,
      items: prepared.materialBundle.items,
      priorStages: prior,
    }),
  ].join('\n');
}

function truncate(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength)}…` : value;
}
