import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from '@earendil-works/pi-ai';
import {
  _consumeExecutionKernel,
  getLosExecutionKernelIdentity,
  type KernelEvent,
  type ToolBroker,
} from './execution-kernel.js';
import {
  _createPiExecutionKernel,
  type PiKernelRunInput,
} from './pi-execution-kernel.js';
import { startPiKernelShadow, type PiKernelShadowOutcome } from './pi-kernel-shadow.js';
import {
  _getPiKernelShadowScenario,
  type PiKernelShadowScenarioId,
} from './pi-kernel-shadow-scenarios.js';
import type { AgentResult } from './loop.js';
import type { SessionEventWrite } from './session-events.js';
import { _verifyPiKernelShadowWorkspaceFixture } from './pi-kernel-shadow-workspace-fixture.js';

export interface PiKernelShadowFixtureObservation {
  scenarioId: PiKernelShadowScenarioId;
  status: PiKernelShadowOutcome['status'];
  passed: boolean;
  assertionFailures: string[];
  sessionId: string;
  candidateInputLineageMatches: boolean;
}

interface FixtureDependencies {
  appendEvent?: (input: SessionEventWrite) => Promise<unknown>;
  id?: () => string;
}

export async function _collectPiKernelShadowDeterministicEvidence(
  counts: Partial<Record<PiKernelShadowScenarioId, number>>,
  dependencies: FixtureDependencies = {},
): Promise<PiKernelShadowFixtureObservation[]> {
  const observations: PiKernelShadowFixtureObservation[] = [];
  for (const scenarioId of scenarioIds()) {
    const count = normalizeCount(counts[scenarioId]);
    for (let index = 0; index < count; index++) {
      observations.push(await collectOne(scenarioId, dependencies));
    }
  }
  return observations;
}

async function collectOne(
  scenarioId: PiKernelShadowScenarioId,
  dependencies: FixtureDependencies,
): Promise<PiKernelShadowFixtureObservation> {
  const scenario = _getPiKernelShadowScenario(scenarioId);
  const suffix = (dependencies.id ?? randomUUID)();
  const sessionId = `session-pi-shadow-fixture-${scenarioId}-${suffix}`;
  const taskRunId = `task-pi-shadow-fixture-${scenarioId}-${suffix}`;
  const traceId = `trace-pi-shadow-fixture-${scenarioId}-${suffix}`;
  const productionResult = productionFixture(scenarioId);
  const workspaceRoot = resolve(import.meta.dirname, '..');
  const workspaceFixture = scenario.workspaceFixture
    ? await _verifyPiKernelShadowWorkspaceFixture(scenario.workspaceFixture, workspaceRoot)
    : undefined;
  const shadow = startPiKernelShadow({
    shadow: {
      kind: 'pi', maxTurns: 2,
      scenario: { id: scenarioId, ...(workspaceFixture ? { workspaceFixture } : {}) },
    },
    prompt: scenario.prompt,
    productionKernel: getLosExecutionKernelIdentity(),
    productionSessionId: sessionId,
    productionTaskRunId: taskRunId,
    productionTraceId: traceId,
    effectiveToolMode: 'read-only',
    remoteExecutor: false,
    config: {
      sessionId,
      taskRunId,
      traceId,
      provider: 'fixture',
      model: 'fixture-model',
      workspaceRoot,
      toolMode: 'read-only',
      sandboxMode: 'readonly',
      allowedTools: scenario.allowedTools,
      maxLoops: 2,
      skipPreExecutionPhases: true,
      identity: { level: 'none' },
    },
  }, {
    runCandidate: async input => runFixtureCandidate(
      scenarioId,
      input.prompt,
      required(input.config.sessionId, 'sessionId'),
      required(input.config.taskRunId, 'taskRunId'),
      required(input.config.traceId, 'traceId'),
      input.config.signal,
    ),
    ...(dependencies.appendEvent ? { appendEvent: dependencies.appendEvent as never } : {}),
  });
  const outcome = await shadow.settle(productionResult);
  const evidence = outcome.scenarioEvidence;
  if (!evidence) throw new Error(`${scenarioId} did not produce scenario evidence`);
  return {
    scenarioId,
    status: outcome.status,
    passed: evidence.passed,
    assertionFailures: evidence.assertions.filter(item => !item.passed).map(item => item.id),
    sessionId,
    candidateInputLineageMatches: outcome.candidateEventLineageMatches,
  };
}

async function runFixtureCandidate(
  scenarioId: PiKernelShadowScenarioId,
  prompt: string,
  sessionId: string,
  taskRunId: string,
  traceId: string,
  signal: AbortSignal | undefined,
): Promise<{
  result?: AgentResult;
  events: KernelEvent[];
  route: { provider: string; model: string; api: string };
  error?: unknown;
}> {
  const fixture = candidateFixture(scenarioId, prompt, sessionId, taskRunId, traceId, signal);
  const events: KernelEvent[] = [];
  const kernel = _createPiExecutionKernel();
  let result: AgentResult | undefined;
  let error: unknown;
  try {
    if (scenarioId === 'PKS05-interruption') {
      for await (const event of kernel.run(fixture)) {
        events.push(event);
        if (event.type === 'kernel.started') {
          await kernel.interrupt({
            runSpecId: fixture.runSpecId!,
            taskRunId: fixture.taskRunId,
            reason: 'deterministic fixture interruption',
          });
        }
      }
    } else {
      result = (await _consumeExecutionKernel<PiKernelRunInput, AgentResult>(
        kernel,
        fixture,
        event => { events.push(event); },
      )).result;
    }
  } catch (candidateError) {
    error = candidateError;
  }
  return {
    ...(result ? { result } : {}),
    events,
    route: { provider: 'fixture', model: 'fixture-model', api: 'openai-completions' },
    ...(error ? { error } : {}),
  };
}

function candidateFixture(
  scenarioId: PiKernelShadowScenarioId,
  prompt: string,
  sessionId: string,
  taskRunId: string,
  traceId: string,
  signal: AbortSignal | undefined,
): PiKernelRunInput {
  const faux = fauxProvider({ tokensPerSecond: 0 });
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses(candidateResponses(scenarioId));
  const toolScenario = scenarioId === 'PKS02-read-only-tool' || scenarioId === 'PKS03-policy-denial';
  return {
    prompt,
    systemPrompt: 'Execute the deterministic LOS Pi shadow fixture exactly.',
    taskRunId,
    sessionId,
    traceId,
    runSpecId: `candidate-run-${randomUUID()}`,
    model: faux.getModel(),
    streamFn: models.streamSimple.bind(models),
    maxTurns: 2,
    signal,
    ...(toolScenario ? {
      toolCatalog: [{
        name: 'read_file',
        description: 'Read one fixture file',
        parameters: {
          type: 'object',
          properties: { path: { type: 'string' } },
          required: ['path'],
        },
      }],
      toolBroker: fixtureBroker(scenarioId === 'PKS03-policy-denial'),
    } : {}),
  };
}

function candidateResponses(scenarioId: PiKernelShadowScenarioId) {
  if (scenarioId === 'PKS01-no-tool') return [fauxAssistantMessage('LOS_PI_SHADOW_OK')];
  if (scenarioId === 'PKS02-read-only-tool') return [
    fauxAssistantMessage(fauxToolCall('read_file', { path: 'package.json' }, { id: 'fixture-read' }), {
      stopReason: 'toolUse',
    }),
    fauxAssistantMessage('{"packageName":"@los/agent"}'),
  ];
  if (scenarioId === 'PKS03-policy-denial') return [
    fauxAssistantMessage(fauxToolCall('read_file', { path: 'package.json' }, { id: 'fixture-denial' }), {
      stopReason: 'toolUse',
    }),
    fauxAssistantMessage('denied'),
  ];
  if (scenarioId === 'PKS04-provider-failure') return [
    fauxAssistantMessage('', { stopReason: 'error', errorMessage: 'deterministic fixture provider failure' }),
  ];
  return [fauxAssistantMessage('must be interrupted')];
}

function fixtureBroker(denied: boolean): ToolBroker {
  return {
    execute: async request => denied
      ? { callId: request.callId, content: '', error: 'deterministic policy denial', denied: true }
      : { callId: request.callId, content: '{"name":"@los/agent"}', denied: false },
  };
}

function productionFixture(scenarioId: PiKernelShadowScenarioId): AgentResult {
  const text = scenarioId === 'PKS01-no-tool' ? 'LOS_PI_SHADOW_OK'
    : scenarioId === 'PKS02-read-only-tool' ? '{"packageName":"@los/agent"}'
    : 'LOS production fixture completed';
  const toolCalls = scenarioId === 'PKS02-read-only-tool'
    ? [{
        id: 'production-read',
        type: 'function' as const,
        function: { name: 'read_file', arguments: '{"path":"package.json"}' },
      }]
    : [];
  return {
    text,
    turns: [{ loopCount: 1, text, toolCalls, toolResults: toolCalls.length ? ['{"name":"@los/agent"}'] : [] }],
    loopCount: 1,
    totalTokens: { prompt: 1, completion: 1 },
    messages: [{ role: 'assistant', content: text, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) }],
  };
}

function scenarioIds(): PiKernelShadowScenarioId[] {
  return [
    'PKS01-no-tool',
    'PKS02-read-only-tool',
    'PKS03-policy-denial',
    'PKS04-provider-failure',
    'PKS05-interruption',
  ];
}

function normalizeCount(value: number | undefined): number {
  if (value === undefined) return 0;
  if (!Number.isSafeInteger(value) || value < 0 || value > 10) {
    throw new Error(`Invalid deterministic fixture observation count: ${value}`);
  }
  return value;
}

function required(value: string | undefined, name: string): string {
  if (value) return value;
  throw new Error(`Deterministic fixture requires ${name}`);
}
