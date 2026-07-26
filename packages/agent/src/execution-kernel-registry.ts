import type { AgentConfig, AgentResult } from './loop.js';
import {
  _consumeExecutionKernel,
  getLosExecutionKernelIdentity,
  runLosExecutionKernel,
  type KernelEvent,
  type KernelIdentity,
} from './execution-kernel.js';
import {
  executionKernelIdentitiesEqual,
  getPiK4KernelSelectionIdentity,
  normalizeExecutionKernelSelection,
  validateK4ExecutionKernelSelection,
} from './execution-kernel-selection.js';
import {
  _createPiExecutionKernel,
  _getPiExecutionKernelIdentity,
  type PiKernelRunInput,
} from './pi-execution-kernel.js';
import { _preparePiKernelRun } from './pi-kernel-input.js';
import type { RunContractMetadata } from './run-contract.js';

export type ExecutionKernelKind = 'los';

export interface ScheduledExecutionKernel {
  identity: KernelIdentity;
  run(
    prompt: string,
    config: AgentConfig,
    onEvent?: (event: KernelEvent) => void | Promise<void>,
  ): Promise<AgentResult>;
}

export interface ExecutionKernelRegistry {
  resolve(kind?: string): ScheduledExecutionKernel;
  list(): KernelIdentity[];
}

export function _createExecutionKernelRegistry(
  kernels: readonly ScheduledExecutionKernel[] = [losScheduledExecutionKernel()],
): ExecutionKernelRegistry {
  const byKind = new Map(kernels.map(kernel => [kernel.identity.kind, kernel]));
  if (byKind.size !== kernels.length) throw new Error('Execution kernel kinds must be unique');

  return {
    resolve(kind = 'los') {
      const kernel = byKind.get(kind);
      if (kernel) return kernel;
      throw new Error(`Unknown execution kernel: ${kind}`);
    },
    list: () => [...byKind.values()].map(kernel => ({ ...kernel.identity })),
  };
}

export function resolveExecutionKernel(kind?: string): ScheduledExecutionKernel {
  return _createExecutionKernelRegistry().resolve(kind);
}

export function resolveExecutionKernelForRun(input: {
  requestedKind?: string;
  runSpecId?: string;
  runContract?: RunContractMetadata;
  toolMode?: string;
  executorEnabled?: boolean;
}): ScheduledExecutionKernel {
  const selection = normalizeExecutionKernelSelection(input.runContract?.executionKernel);
  if (!selection) return resolveExecutionKernel(input.requestedKind);
  if (!input.runSpecId) throw new Error('Explicit execution-kernel selection requires a persisted run spec');
  if (input.requestedKind && input.requestedKind !== selection.selected.kind) {
    throw new Error(`Requested execution kernel ${input.requestedKind} does not match persisted selection ${selection.selected.kind}`);
  }
  if (executionKernelIdentitiesEqual(selection.selected, getPiK4KernelSelectionIdentity())) {
    const error = validateK4ExecutionKernelSelection(selection, {
      runContractMode: input.runContract?.mode,
      toolMode: input.toolMode,
      executorEnabled: input.executorEnabled,
      requireCanaryAuthorization: true,
    });
    if (error) throw new Error(error);
    return piScheduledExecutionKernel();
  }
  return resolveExecutionKernel(selection.selected.kind);
}

function losScheduledExecutionKernel(): ScheduledExecutionKernel {
  return {
    identity: getLosExecutionKernelIdentity(),
    run: (prompt, config, onEvent) => runLosExecutionKernel(prompt, config, onEvent),
  };
}

function piScheduledExecutionKernel(): ScheduledExecutionKernel {
  return {
    identity: _getPiExecutionKernelIdentity(),
    run: async (prompt, config, onEvent) => {
      const prepared = await _preparePiKernelRun(prompt, config);
      try {
        return (await _consumeExecutionKernel<PiKernelRunInput, AgentResult>(
          _createPiExecutionKernel(),
          prepared.input,
          onEvent,
        )).result;
      } finally {
        await prepared.cleanup();
      }
    },
  };
}
