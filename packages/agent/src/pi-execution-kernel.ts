import {
  runAgentLoop,
  type AgentEvent,
  type AgentMessage,
  type AgentTool,
  type StreamFn,
} from '@earendil-works/pi-agent-core';
import {
  Type,
  type AssistantMessage,
  type Message as PiMessage,
  type Model,
  type SimpleStreamOptions,
  type TSchema,
  type ToolResultMessage,
} from '@earendil-works/pi-ai';
import {
  type ExecutionKernel,
  type KernelCheckpoint,
  type KernelEvent,
  type KernelEventType,
  type KernelIdentity,
  type KernelResumeInput,
  type KernelRunInput,
  type ToolBroker,
} from './execution-kernel.js';
import type { AgentResult, TurnSummary } from './loop.js';
import type { Message, ToolCall } from './providers/index.js';

const PI_VERSION = '0.81.1';
const PI_CHECKPOINT_CODEC = 'pi-agent-core-messages-v1';
const PI_KERNEL_IDENTITY: KernelIdentity = Object.freeze({
  kind: 'pi',
  version: PI_VERSION,
  protocolVersion: '0.1.0',
});

export interface PiKernelToolDescriptor {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  parallelizable?: boolean;
}

export interface PiKernelRunInput extends KernelRunInput {
  systemPrompt: string;
  model: Model<any>;
  streamFn: StreamFn;
  initialMessages?: readonly AgentMessage[];
  maxTurns?: number;
  modelOptions?: Pick<SimpleStreamOptions, 'temperature' | 'maxTokens' | 'reasoning'>;
  toolCatalog?: readonly PiKernelToolDescriptor[];
  toolBroker?: ToolBroker;
  signal?: AbortSignal;
}
interface PiExecutionKernelOptions {
  now?: () => Date;
}

export function _createPiExecutionKernel(
  options: PiExecutionKernelOptions = {},
): ExecutionKernel<PiKernelRunInput> {
  const now = options.now ?? (() => new Date());
  const activeRuns = new Map<string, AbortController>();
  return {
    identity: PI_KERNEL_IDENTITY,
    capabilities: () => ({
      streaming: true,
      typedTools: true,
      parallelToolCalls: true,
      steering: false,
      followUp: false,
      interrupt: true,
      checkpoint: true,
      resume: true,
      compaction: false,
    }),
    run: input => runPiAsKernel(input, [...(input.initialMessages ?? [])], activeRuns, now),
    interrupt: async input => {
      const controller = activeRuns.get(input.taskRunId);
      if (!controller) return { accepted: false, reason: 'Pi kernel attempt is not active' };
      controller.abort(input.reason);
      return { accepted: true };
    },
    resume: input => resumePiKernel(input, activeRuns, now),
  };
}
export function _getPiExecutionKernelIdentity(): KernelIdentity {
  return { ...PI_KERNEL_IDENTITY };
}

async function* resumePiKernel(
  input: KernelResumeInput<PiKernelRunInput>,
  activeRuns: Map<string, AbortController>,
  now: () => Date,
): AsyncGenerator<KernelEvent> {
  const checkpoint = input.checkpoint;
  if (checkpoint.kernel.kind !== 'pi' || checkpoint.kernel.version !== PI_VERSION ||
      checkpoint.codec !== PI_CHECKPOINT_CODEC || !Array.isArray(checkpoint.value)) {
    yield kernelEvent(0, 'kernel.failed', now, {
      error: `Unsupported Pi checkpoint ${checkpoint.kernel.kind}@${checkpoint.kernel.version}/${checkpoint.codec}`,
    });
    throw new Error('Pi execution kernel cannot resume the supplied checkpoint');
  }
  yield* runPiAsKernel(input.run, checkpoint.value as AgentMessage[], activeRuns, now);
}

async function* runPiAsKernel(
  input: PiKernelRunInput,
  priorMessages: AgentMessage[],
  activeRuns: Map<string, AbortController>,
  now: () => Date,
): AsyncGenerator<KernelEvent> {
  if (activeRuns.has(input.taskRunId)) {
    throw new Error(`Pi execution kernel already has an active attempt ${input.taskRunId}`);
  }
  if ((input.toolCatalog?.length ?? 0) > 0 && !input.toolBroker) {
    throw new Error('Pi execution kernel requires the LOS ToolBroker for every declared tool');
  }
  const queue: Array<{ event: KernelEvent; acknowledge: () => void }> = [];
  const controller = new AbortController();
  const unlink = linkAbortSignal(input.signal, controller);
  let sequence = 0;
  let turn = 0;
  let closed = false;
  let consumerClosed = false;
  let failure: unknown;
  let wake: (() => void) | undefined;
  let pendingAcknowledge: (() => void) | undefined;

  const emit = (type: KernelEventType, payload: Record<string, unknown>, context: Partial<KernelEvent> = {}) => {
    if (consumerClosed) return Promise.resolve();
    let acknowledge = () => {};
    const settled = new Promise<void>(resolve => { acknowledge = resolve; });
    queue.push({
      event: kernelEvent(sequence++, type, now, payload, context),
      acknowledge,
    });
    wake?.();
    wake = undefined;
    return settled;
  };
  activeRuns.set(input.taskRunId, controller);
  const turns: TurnSummary[] = [];
  const deniedToolCalls = new Set<string>();
  const execution = (async () => {
    try {
      await emit('kernel.started', {
        runSpecId: input.runSpecId ?? null,
        taskRunId: input.taskRunId,
        sessionId: input.sessionId,
      });
      const prompt: AgentMessage = { role: 'user', content: input.prompt, timestamp: now().getTime() };
      const messages = await runAgentLoop(
        [prompt],
        {
          systemPrompt: input.systemPrompt,
          messages: [...priorMessages],
          tools: createPiTools(input, () => turn, deniedToolCalls),
        },
        {
          model: input.model,
          convertToLlm: messages => messages.filter(isPiLlmMessage),
          toolExecution: 'parallel',
          ...input.modelOptions,
          shouldStopAfterTurn: input.maxTurns
            ? () => turn >= input.maxTurns!
            : undefined,
        },
        event => projectPiEvent(event, () => turn, value => { turn = value; }, turns, deniedToolCalls, emit),
        controller.signal,
        input.streamFn,
      );

      const lastAssistant = [...messages].reverse().find(isAssistantMessage);
      if (lastAssistant?.stopReason === 'aborted' || controller.signal.aborted) {
        await emit('kernel.interrupted', {
          reason: String(controller.signal.reason ?? lastAssistant?.errorMessage ?? 'aborted'),
        });
        return;
      }
      if (lastAssistant?.stopReason === 'error') {
        throw new Error(lastAssistant.errorMessage ?? 'Pi provider stream failed');
      }

      const checkpoint: KernelCheckpoint = {
        kernel: PI_KERNEL_IDENTITY,
        codec: PI_CHECKPOINT_CODEC,
        value: [...priorMessages, ...messages],
      };
      await emit('checkpoint.created', { checkpoint });
      const result = buildAgentResult([...priorMessages, ...messages], turns, messages);
      await emit('kernel.finished', { result });
    } catch (error) {
      failure = error;
      await emit('kernel.failed', { error: error instanceof Error ? error.message : String(error) });
    } finally {
      activeRuns.delete(input.taskRunId);
      unlink();
      closed = true;
      wake?.();
      wake = undefined;
    }
  })();

  try {
    while (!closed || queue.length > 0) {
      const queued = queue.shift();
      if (queued) {
        pendingAcknowledge = queued.acknowledge;
        yield queued.event;
        pendingAcknowledge();
        pendingAcknowledge = undefined;
        continue;
      }
      await new Promise<void>(resolve => { wake = resolve; });
    }
  } finally {
    consumerClosed = true;
    if (!closed) controller.abort('kernel event consumer stopped');
    pendingAcknowledge?.();
    for (const queued of queue.splice(0)) queued.acknowledge();
    await execution;
  }
  if (failure) throw failure;
}
async function projectPiEvent(
  event: AgentEvent,
  readTurn: () => number,
  writeTurn: (turn: number) => void,
  turns: TurnSummary[],
  deniedToolCalls: Set<string>,
  emit: (type: KernelEventType, payload: Record<string, unknown>, context?: Partial<KernelEvent>) => Promise<void>,
): Promise<void> {
  if (event.type === 'turn_start') {
    const turn = readTurn() + 1;
    writeTurn(turn);
    await emit('turn.started', {}, { turn });
    return;
  }
  const turn = readTurn();
  if (event.type === 'message_update') {
    const update = event.assistantMessageEvent;
    if (update.type === 'text_delta') {
      await emit('message.delta', { delta: { textDelta: update.delta, model: update.partial.model } }, { turn });
    } else if (update.type === 'thinking_delta') {
      await emit('message.delta', { delta: { reasoningDelta: update.delta, model: update.partial.model } }, { turn });
    }
    return;
  }
  if (event.type === 'message_end' && isAssistantMessage(event.message)) {
    await emit('message.completed', summarizeAssistant(event.message), { turn });
    await emit('usage.recorded', {
      totalTokens: { prompt: event.message.usage.input, completion: event.message.usage.output },
    }, { turn });
    return;
  }
  if (event.type === 'tool_execution_start') {
    await emit('tool.requested', { tool: event.toolName, args: event.args }, {
      turn,
      toolCallId: event.toolCallId,
    });
    return;
  }
  if (event.type === 'tool_execution_end') {
    await emit('tool.completed', {
      transition: {
        callId: event.toolCallId,
        toolName: event.toolName,
        state: deniedToolCalls.delete(event.toolCallId) ? 'denied' : event.isError ? 'failed' : 'succeeded',
        turn,
      },
    }, { turn, toolCallId: event.toolCallId });
    return;
  }
  if (event.type === 'turn_end' && isAssistantMessage(event.message)) {
    const summary = toTurnSummary(turn, event.message, event.toolResults);
    turns.push(summary);
    await emit('turn.completed', { summary }, { turn });
  }
}
function createPiTools(input: PiKernelRunInput, readTurn: () => number, deniedToolCalls: Set<string>): AgentTool[] {
  return (input.toolCatalog ?? []).map(descriptor => ({
    name: descriptor.name,
    label: descriptor.name,
    description: descriptor.description,
    parameters: Type.Unsafe<Record<string, unknown>>(descriptor.parameters as TSchema),
    executionMode: descriptor.parallelizable ? 'parallel' : 'sequential',
    execute: async (callId, parameters) => {
      const result = await input.toolBroker!.execute({
        callId,
        name: descriptor.name,
        arguments: parameters as Record<string, unknown>,
        turn: readTurn(),
      });
      if ('denied' in result && result.denied === true) deniedToolCalls.add(callId);
      if (result.error) throw new Error(result.error);
      return {
        content: [{ type: 'text', text: result.content }],
        details: {},
      };
    },
  }));
}
function buildAgentResult(
  messages: AgentMessage[],
  turns: TurnSummary[],
  invocationMessages: AgentMessage[],
): AgentResult {
  const assistants = invocationMessages.filter(isAssistantMessage);
  const last = assistants.at(-1);
  return {
    text: last ? contentText(last) : '',
    turns,
    loopCount: turns.length,
    totalTokens: assistants.reduce((usage, message) => ({
      prompt: usage.prompt + message.usage.input,
      completion: usage.completion + message.usage.output,
    }), { prompt: 0, completion: 0 }),
    messages: messages.flatMap(toLosMessage),
  };
}
function toTurnSummary(turn: number, message: AssistantMessage, toolResults: ToolResultMessage[]): TurnSummary {
  return {
    loopCount: turn,
    text: contentText(message),
    reasoningContent: message.content.filter(block => block.type === 'thinking').map(block => block.thinking).join('') || undefined,
    toolCalls: message.content.filter(block => block.type === 'toolCall').map(toLosToolCall),
    toolResults: toolResults.map(contentText),
  };
}
function summarizeAssistant(message: AssistantMessage): Record<string, unknown> {
  return {
    text: contentText(message),
    reasoningContent: message.content.filter(block => block.type === 'thinking').map(block => block.thinking).join(''),
    toolCalls: message.content.filter(block => block.type === 'toolCall').map(toLosToolCall),
  };
}
function toLosToolCall(call: Extract<AssistantMessage['content'][number], { type: 'toolCall' }>): ToolCall {
  return {
    id: call.id,
    type: 'function',
    function: { name: call.name, arguments: JSON.stringify(call.arguments) },
  };
}
function toLosMessage(message: AgentMessage): Message[] {
  if (message.role === 'user') return [{ role: 'user', content: contentText(message) }];
  if (message.role === 'assistant') {
    return [{
      role: 'assistant',
      content: contentText(message),
      tool_calls: message.content.filter(block => block.type === 'toolCall').map(toLosToolCall),
    }];
  }
  if (message.role === 'toolResult') {
    return [{ role: 'tool', content: contentText(message), tool_call_id: message.toolCallId }];
  }
  return [];
}
function contentText(message: { content: unknown }): string {
  if (typeof message.content === 'string') return message.content;
  if (!Array.isArray(message.content)) return '';
  return message.content.flatMap(block => {
    if (!block || typeof block !== 'object') return [];
    if ('text' in block && typeof block.text === 'string') return [block.text];
    return [];
  }).join('');
}
function isAssistantMessage(message: AgentMessage): message is AssistantMessage {
  return message.role === 'assistant';
}

function isPiLlmMessage(message: AgentMessage): message is PiMessage {
  return message.role === 'user' || message.role === 'assistant' || message.role === 'toolResult';
}
function kernelEvent(
  sequence: number,
  type: KernelEventType,
  now: () => Date,
  payload: Record<string, unknown>,
  context: Partial<KernelEvent> = {},
): KernelEvent {
  return {
    sequence,
    type,
    occurredAt: now().toISOString(),
    kernel: PI_KERNEL_IDENTITY,
    ...(context.turn === undefined ? {} : { turn: context.turn }),
    ...(context.messageId === undefined ? {} : { messageId: context.messageId }),
    ...(context.toolCallId === undefined ? {} : { toolCallId: context.toolCallId }),
    payload,
  };
}
function linkAbortSignal(source: AbortSignal | undefined, target: AbortController): () => void {
  if (!source) return () => {};
  const abort = () => target.abort(source.reason);
  if (source.aborted) abort();
  else source.addEventListener('abort', abort, { once: true });
  return () => source.removeEventListener('abort', abort);
}
