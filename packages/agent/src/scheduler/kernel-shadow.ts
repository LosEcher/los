import { startPiKernelShadow, type PiKernelShadowHandle } from '../pi-kernel-shadow.js';
import type { KernelIdentity } from '../execution-kernel.js';
import type { AgentConfig } from '../loop.js';
import type { ScheduledAgentTaskInput } from './types.js';

export function startScheduledKernelShadow(input: {
  task: ScheduledAgentTaskInput;
  prompt: string;
  productionKernel: KernelIdentity;
  sessionId: string;
  taskRunId: string;
  traceId: string;
  toolMode: AgentConfig['toolMode'];
  remoteExecutor: boolean;
  config: AgentConfig;
}): PiKernelShadowHandle | undefined {
  if (!input.task.executionKernelShadow) return undefined;
  return startPiKernelShadow({
    shadow: input.task.executionKernelShadow,
    prompt: input.prompt,
    productionKernel: input.productionKernel,
    productionSessionId: input.sessionId,
    productionTaskRunId: input.taskRunId,
    productionTraceId: input.traceId,
    effectiveToolMode: input.toolMode,
    remoteExecutor: input.remoteExecutor,
    config: input.config,
  });
}
