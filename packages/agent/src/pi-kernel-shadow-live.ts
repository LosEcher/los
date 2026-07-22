import { randomUUID } from 'node:crypto';
import { runScheduledAgentTask } from './scheduler.js';
import {
  _PI_KERNEL_SHADOW_CORPUS_VERSION,
  _getPiKernelShadowScenario,
  type PiKernelShadowScenarioId,
} from './pi-kernel-shadow-scenarios.js';
import type { ScheduledAgentTaskInput, ScheduledAgentTaskResult } from './scheduler/types.js';

export interface PiKernelShadowLiveObservation {
  scenarioId: 'PKS01-no-tool' | 'PKS02-read-only-tool';
  taskRunId: string;
  sessionId: string;
  status: ScheduledAgentTaskResult['status'] | 'failed';
  error?: string;
}

interface LiveDependencies {
  run?: (input: ScheduledAgentTaskInput) => Promise<ScheduledAgentTaskResult>;
  id?: () => string;
}

export async function _collectPiKernelShadowLiveEvidence(
  input: {
    provider: string;
    model: string;
    counts: Partial<Record<'PKS01-no-tool' | 'PKS02-read-only-tool', number>>;
    workspaceRoot?: string;
  },
  dependencies: LiveDependencies = {},
): Promise<PiKernelShadowLiveObservation[]> {
  const observations: PiKernelShadowLiveObservation[] = [];
  for (const scenarioId of liveScenarioIds()) {
    const count = normalizeCount(input.counts[scenarioId]);
    for (let index = 0; index < count; index++) {
      observations.push(await collectOne(scenarioId, input, dependencies));
    }
  }
  return observations;
}

async function collectOne(
  scenarioId: 'PKS01-no-tool' | 'PKS02-read-only-tool',
  input: Parameters<typeof _collectPiKernelShadowLiveEvidence>[0],
  dependencies: LiveDependencies,
): Promise<PiKernelShadowLiveObservation> {
  const scenario = _getPiKernelShadowScenario(scenarioId);
  const suffix = (dependencies.id ?? randomUUID)();
  const sessionId = `session-pi-shadow-live-${scenarioId}-${suffix}`;
  const taskRunId = `task-pi-shadow-live-${scenarioId}-${suffix}`;
  try {
    const result = await (dependencies.run ?? runScheduledAgentTask)({
      prompt: scenario.prompt,
      sessionId,
      taskRunId,
      traceId: `trace-pi-shadow-live-${scenarioId}-${suffix}`,
      provider: input.provider,
      model: input.model,
      workspaceRoot: input.workspaceRoot ?? process.cwd(),
      toolMode: 'read-only',
      sandboxMode: 'readonly',
      allowedTools: scenario.allowedTools,
      maxLoops: 3,
      modelSettings: { temperature: 0 },
      skipPreExecutionPhases: true,
      identity: { level: 'none' },
      executionKernelShadow: { kind: 'pi', maxTurns: 3, scenario: { id: scenarioId } },
      metadata: {
        evidencePurpose: 'pi-kernel-shadow-live',
        corpusVersion: _PI_KERNEL_SHADOW_CORPUS_VERSION,
        scenarioId,
      },
    });
    return { scenarioId, taskRunId, sessionId, status: result.status };
  } catch (error) {
    return {
      scenarioId,
      taskRunId,
      sessionId,
      status: 'failed',
      error: truncate(error instanceof Error ? error.message : String(error)),
    };
  }
}

function liveScenarioIds(): Array<'PKS01-no-tool' | 'PKS02-read-only-tool'> {
  return ['PKS01-no-tool', 'PKS02-read-only-tool'];
}

function normalizeCount(value: number | undefined): number {
  if (value === undefined) return 0;
  if (!Number.isSafeInteger(value) || value < 0 || value > 3) {
    throw new Error(`Invalid live observation count: ${value}`);
  }
  return value;
}

function truncate(value: string): string {
  return value.length <= 500 ? value : `${value.slice(0, 500)}...[truncated]`;
}
