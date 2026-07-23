import type { AgentConfig, AgentResult } from './loop.js';
import {
  getLosExecutionKernelIdentity,
  runLosExecutionKernel,
  type KernelEvent,
  type KernelIdentity,
} from './execution-kernel.js';

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

function losScheduledExecutionKernel(): ScheduledExecutionKernel {
  return {
    identity: getLosExecutionKernelIdentity(),
    run: (prompt, config, onEvent) => runLosExecutionKernel(prompt, config, onEvent),
  };
}
