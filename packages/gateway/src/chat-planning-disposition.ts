import type { RunContractMetadataInput } from '@los/agent';
import type { ScheduledAgentTaskInput } from '@los/agent/scheduler';

export function prepareChatPlanningDisposition(input: {
  boundTodoId?: string;
  runContract?: RunContractMetadataInput;
}): {
  runContract: RunContractMetadataInput | undefined;
  disposition: ScheduledAgentTaskInput['disposition'];
} {
  const phase = input.runContract?.phase;
  if (input.boundTodoId && phase === 'created') {
    return {
      runContract: {
        ...input.runContract,
        phase: 'planning',
        previousPhase: 'created',
        phaseChangedAt: new Date().toISOString(),
      },
      disposition: 'planning',
    };
  }
  return {
    runContract: input.runContract,
    disposition: phase === 'planning' ? 'planning' : 'execution',
  };
}
