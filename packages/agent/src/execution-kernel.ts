import { runAgent, type AgentConfig, type AgentResult } from './loop.js';

const EXECUTION_KERNEL_PROTOCOL_VERSION = '0.1.0';

export interface KernelIdentity {
  kind: string;
  version: string;
  protocolVersion: string;
}

export interface KernelCapabilities {
  streaming: boolean;
  typedTools: boolean;
  parallelToolCalls: boolean;
  steering: boolean;
  followUp: boolean;
  interrupt: boolean;
  checkpoint: boolean;
  resume: boolean;
  compaction: boolean;
}

export type KernelEventType =
  | 'kernel.started'
  | 'turn.started'
  | 'message.delta'
  | 'message.completed'
  | 'tool.requested'
  | 'tool.completed'
  | 'usage.recorded'
  | 'checkpoint.created'
  | 'turn.completed'
  | 'kernel.finished'
  | 'kernel.interrupted'
  | 'kernel.failed';

export interface KernelEvent {
  sequence: number;
  type: KernelEventType;
  occurredAt: string;
  kernel: KernelIdentity;
  turn?: number;
  messageId?: string;
  toolCallId?: string;
  payload: Record<string, unknown>;
}

export interface KernelRunInput {
  prompt: string;
  taskRunId: string;
  sessionId: string;
  traceId: string;
  runSpecId?: string;
  requestId?: string;
}

export interface LosKernelRunInput extends KernelRunInput {
  agentConfig: AgentConfig;
}

export interface KernelResumeInput<TInput extends KernelRunInput = KernelRunInput> {
  run: TInput;
  checkpoint: KernelCheckpoint;
}

export interface KernelCheckpoint {
  kernel: KernelIdentity;
  codec: string;
  value: unknown;
}

export interface KernelInterruptInput {
  runSpecId: string;
  taskRunId: string;
  reason: string;
}

export interface KernelInterruptResult {
  accepted: boolean;
  reason?: string;
}

export interface KernelToolRequest {
  callId: string;
  name: string;
  arguments: Record<string, unknown>;
  turn: number;
}

export interface KernelToolResult {
  callId: string;
  content: string;
  error?: string;
}

export interface ToolBroker<TResult extends KernelToolResult = KernelToolResult> {
  execute(request: KernelToolRequest): Promise<TResult>;
}

export interface ExecutionKernel<TInput extends KernelRunInput = KernelRunInput> {
  readonly identity: KernelIdentity;
  capabilities(): KernelCapabilities;
  run(input: TInput): AsyncIterable<KernelEvent>;
  interrupt(input: KernelInterruptInput): Promise<KernelInterruptResult>;
  resume(input: KernelResumeInput<TInput>): AsyncIterable<KernelEvent>;
}

export interface KernelRunResult<TResult = unknown> {
  result: TResult;
  terminalEvent: KernelEvent;
}

type AgentRunner = (prompt: string, config: AgentConfig) => Promise<AgentResult>;

interface LosExecutionKernelOptions {
  runner?: AgentRunner;
  now?: () => Date;
}

const LOS_KERNEL_IDENTITY: KernelIdentity = Object.freeze({
  kind: 'los',
  version: '0.1.0',
  protocolVersion: EXECUTION_KERNEL_PROTOCOL_VERSION,
});

export function _createLosExecutionKernel(
  options: LosExecutionKernelOptions = {},
): ExecutionKernel<LosKernelRunInput> {
  const runner = options.runner ?? runAgent;
  const now = options.now ?? (() => new Date());

  return {
    identity: LOS_KERNEL_IDENTITY,
    capabilities: () => ({
      streaming: true,
      typedTools: true,
      parallelToolCalls: true,
      steering: true,
      followUp: true,
      interrupt: false,
      checkpoint: true,
      resume: false,
      compaction: true,
    }),
    run: input => runLosAgentAsKernel(input, runner, now),
    interrupt: async () => ({
      accepted: false,
      reason: 'Interrupt is owned by the scheduler AbortSignal in the LOS adapter',
    }),
    resume: input => unsupportedResume(input, now),
  };
}

export async function _consumeExecutionKernel<TInput extends KernelRunInput, TResult = unknown>(
  kernel: ExecutionKernel<TInput>,
  input: TInput,
  onEvent?: (event: KernelEvent) => void | Promise<void>,
): Promise<KernelRunResult<TResult>> {
  let terminalEvent: KernelEvent | undefined;
  let result: TResult | undefined;

  for await (const event of kernel.run(input)) {
    await onEvent?.(event);
    if (event.type !== 'kernel.finished') continue;
    terminalEvent = event;
    result = event.payload.result as TResult | undefined;
  }

  if (!terminalEvent || !result) {
    throw new Error(`Execution kernel ${kernel.identity.kind} ended without kernel.finished`);
  }
  return { result, terminalEvent };
}

export async function runLosExecutionKernel(
  prompt: string,
  agentConfig: AgentConfig,
  onEvent?: (event: KernelEvent) => void | Promise<void>,
): Promise<AgentResult> {
  const taskRunId = requiredKernelContext(agentConfig.taskRunId, 'taskRunId');
  const sessionId = requiredKernelContext(agentConfig.sessionId, 'sessionId');
  const traceId = requiredKernelContext(agentConfig.traceId, 'traceId');
  const consumed = await _consumeExecutionKernel<LosKernelRunInput, AgentResult>(
    _createLosExecutionKernel(),
    {
      prompt,
      taskRunId,
      sessionId,
      traceId,
      runSpecId: agentConfig.runSpecId,
      requestId: agentConfig.requestId,
      agentConfig,
    },
    onEvent,
  );
  return consumed.result;
}

export function getLosExecutionKernelIdentity(): KernelIdentity {
  return { ...LOS_KERNEL_IDENTITY };
}

async function* runLosAgentAsKernel(
  input: LosKernelRunInput,
  runner: AgentRunner,
  now: () => Date,
): AsyncGenerator<KernelEvent> {
  const queue: KernelEvent[] = [];
  const startedTurns = new Set<number>();
  let sequence = 0;
  let closed = false;
  let failure: unknown;
  let wake: (() => void) | undefined;

  const emit = (
    type: KernelEventType,
    payload: Record<string, unknown>,
    context: Pick<KernelEvent, 'turn' | 'messageId' | 'toolCallId'> = {},
  ): void => {
    queue.push({
      sequence: sequence++,
      type,
      occurredAt: now().toISOString(),
      kernel: LOS_KERNEL_IDENTITY,
      ...context,
      payload,
    });
    wake?.();
    wake = undefined;
  };
  const startTurn = (turn: number): void => {
    if (startedTurns.has(turn)) return;
    startedTurns.add(turn);
    emit('turn.started', {}, { turn });
  };
  const close = (): void => {
    closed = true;
    wake?.();
    wake = undefined;
  };

  emit('kernel.started', {
    runSpecId: input.runSpecId ?? null,
    taskRunId: input.taskRunId,
    sessionId: input.sessionId,
  });

  const execution = runner(input.prompt, {
    ...input.agentConfig,
    onTurn: async turn => {
      startTurn(turn.loopCount);
      emit('message.completed', {
        text: turn.text,
        toolCalls: turn.toolCalls,
        reasoningContent: turn.reasoningContent ?? null,
      }, { turn: turn.loopCount });
      emit('turn.completed', { summary: turn }, { turn: turn.loopCount });
      await input.agentConfig.onTurn?.(turn);
    },
    onModelDelta: async delta => {
      startTurn(delta.turn);
      emit('message.delta', { delta }, { turn: delta.turn });
      await input.agentConfig.onModelDelta?.(delta);
    },
    onToolCall: async (callId, tool, args, turn) => {
      startTurn(turn);
      emit('tool.requested', { tool, args }, { turn, toolCallId: callId });
      await input.agentConfig.onToolCall?.(callId, tool, args, turn);
    },
    onToolCallState: async transition => {
      if (transition.state === 'succeeded' || transition.state === 'failed' || transition.state === 'denied') {
        startTurn(transition.turn);
        emit('tool.completed', { transition }, {
          turn: transition.turn,
          toolCallId: transition.callId,
        });
      }
      await input.agentConfig.onToolCallState?.(transition);
    },
    onCheckpoint: async checkpoint => {
      emit('checkpoint.created', {
        checkpoint: {
          kernel: LOS_KERNEL_IDENTITY,
          codec: 'los-agent-checkpoint-v1',
          value: checkpoint,
        } satisfies KernelCheckpoint,
      });
      await input.agentConfig.onCheckpoint?.(checkpoint);
    },
  }).then(result => {
    emit('usage.recorded', { totalTokens: result.totalTokens });
    emit('kernel.finished', { result });
  }).catch(error => {
    failure = error;
    emit('kernel.failed', {
      error: error instanceof Error ? error.message : String(error),
    });
  }).finally(close);

  while (!closed || queue.length > 0) {
    const event = queue.shift();
    if (event) {
      yield event;
      continue;
    }
    await new Promise<void>(resolve => {
      wake = resolve;
    });
  }
  await execution;
  if (failure) throw failure;
}

async function* unsupportedResume(
  input: KernelResumeInput<LosKernelRunInput>,
  now: () => Date,
): AsyncGenerator<KernelEvent> {
  yield {
    sequence: 0,
    type: 'kernel.failed',
    occurredAt: now().toISOString(),
    kernel: LOS_KERNEL_IDENTITY,
    payload: {
      error: `Checkpoint resume is not implemented for ${input.checkpoint.codec}`,
    },
  };
  throw new Error(`LOS execution kernel cannot resume checkpoint codec ${input.checkpoint.codec}`);
}

function requiredKernelContext(value: string | undefined, field: string): string {
  if (value) return value;
  throw new Error(`LOS execution kernel requires ${field}`);
}
