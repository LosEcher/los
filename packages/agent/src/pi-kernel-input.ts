import {
  createModels,
  createProvider as createPiProvider,
  createAssistantMessageEventStream,
  type AssistantMessageEvent,
  type Api,
  type Model,
  type ProviderStreams,
} from '@earendil-works/pi-ai';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { anthropicMessagesApi } from '@earendil-works/pi-ai/api/anthropic-messages.lazy';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';
import { openAIResponsesApi } from '@earendil-works/pi-ai/api/openai-responses.lazy';
import { createLosToolBroker } from './los-tool-broker.js';
import { resolveXaiOAuthCredential } from './auth/xai-oauth.js';
import { completeAgentSetup, setupAgentRun } from './loop/setup.js';
import type { AgentConfig, AgentResult } from './loop.js';
import type { ModelProfile } from './model-profiles.js';
import { getProviderConfig } from './providers/index.js';
import { recordProviderCall, type ProviderCallTelemetry } from './providers/telemetry.js';
import type { Message } from './providers/index.js';
import type { PiKernelRunInput, PiKernelToolDescriptor } from './pi-execution-kernel.js';

interface PiKernelRouteEvidence {
  provider: string;
  model: string;
  api: Api;
  configuredBaseUrl: string;
  effectiveBaseUrl: string;
  toolNames: string[];
}

export interface PreparedPiKernelRun {
  input: PiKernelRunInput;
  route: PiKernelRouteEvidence;
  cleanup(): Promise<void>;
}

interface PiKernelInputDependencies {
  now?: () => Date;
  resolveCredential?: (provider: string) => Promise<{ apiKey?: string; baseUrl?: string }>;
  recordProviderCall?: (telemetry: ProviderCallTelemetry) => Promise<void>;
}

export async function _preparePiKernelRun(
  prompt: string,
  config: AgentConfig,
  dependencies: PiKernelInputDependencies = {},
): Promise<PreparedPiKernelRun> {
  assertSupportedConfig(config);
  const setup = setupAgentRun(prompt, config, unsupportedChildRunner);
  await completeAgentSetup(prompt, config, setup);

  try {
    const modelRuntime = await createPiModelRuntime(
      setup.provider.profile,
      dependencies.resolveCredential ?? resolveLosCredential,
      {
        traceId: required(config.traceId, 'traceId'),
        sessionId: config.sessionId,
        record: dependencies.recordProviderCall ?? recordProviderCall,
      },
    );
    const messages = toPiMessages(setup.messages.slice(0, -1), modelRuntime.model, dependencies.now);
    const toolCatalog = toPiToolCatalog(setup);
    const broker = createLosToolBroker({
      tools: setup.tools,
      config,
      signal: setup.signal,
      policy: setup.policy,
      emitEvent: async event => (
        await setup.emitEvent(event as Parameters<typeof setup.emitEvent>[0]) ?? undefined
      ),
      onSessionError: () => {},
      preActionGateConfig: setup.preActionGateConfig,
    });

    return {
      input: {
        prompt,
        systemPrompt: readSystemPrompt(setup.messages),
        taskRunId: required(config.taskRunId, 'taskRunId'),
        sessionId: required(config.sessionId, 'sessionId'),
        traceId: required(config.traceId, 'traceId'),
        runSpecId: config.runSpecId,
        requestId: config.requestId,
        model: modelRuntime.model,
        streamFn: modelRuntime.streamFn,
        initialMessages: messages,
        maxTurns: setup.maxLoops,
        modelOptions: toPiModelOptions(config),
        toolCatalog,
        toolBroker: broker,
        signal: config.signal,
      },
      route: {
        provider: modelRuntime.model.provider,
        model: modelRuntime.model.id,
        api: modelRuntime.model.api,
        configuredBaseUrl: modelRuntime.model.baseUrl,
        effectiveBaseUrl: modelRuntime.effectiveBaseUrl,
        toolNames: toolCatalog.map(tool => tool.name),
      },
      cleanup: setup.mcpCleanup,
    };
  } catch (error) {
    await setup.mcpCleanup();
    throw error;
  }
}

async function createPiModelRuntime(
  profile: ModelProfile,
  resolveCredential: PiKernelInputDependencies['resolveCredential'],
  telemetry: {
    traceId: string;
    sessionId?: string;
    record: (telemetry: ProviderCallTelemetry) => Promise<void>;
  },
): Promise<{
  model: Model<Api>;
  streamFn: PiKernelRunInput['streamFn'];
  effectiveBaseUrl: string;
}> {
  let pendingCredential: { apiKey?: string; baseUrl?: string } | undefined =
    await resolveCredential!(profile.provider);
  assertCredential(profile, pendingCredential);
  const api = toPiApi(profile);
  const model: Model<Api> = {
    id: profile.model,
    name: profile.model,
    api,
    provider: profile.provider,
    baseUrl: profile.baseUrl,
    reasoning: profile.supportsReasoning,
    input: profile.supportsVision ? ['text', 'image'] : ['text'],
    cost: {
      input: profile.pricing?.promptTokenCostPer1M ?? 0,
      output: profile.pricing?.completionTokenCostPer1M ?? 0,
      cacheRead: profile.pricing?.cacheHitTokenCostPer1M ?? 0,
      cacheWrite: 0,
    },
    contextWindow: profile.maxInputTokens ?? 200_000,
    maxTokens: profile.maxOutputTokens ?? 32_000,
  };
  const provider = createPiProvider({
    id: profile.provider,
    name: profile.provider,
    baseUrl: profile.baseUrl,
    auth: {
      apiKey: {
        name: `LOS ${profile.provider} credential`,
        resolve: async () => {
          const credential = pendingCredential ?? await resolveCredential!(profile.provider);
          pendingCredential = undefined;
          if (!credential.apiKey && !isLoopback(credential.baseUrl ?? profile.baseUrl)) return undefined;
          return { auth: { apiKey: credential.apiKey, baseUrl: credential.baseUrl ?? profile.baseUrl } };
        },
      },
    },
    models: [model],
    api: apiImplementation(api),
  });
  const models = createModels();
  models.setProvider(provider);
  const streamFn: PiKernelRunInput['streamFn'] = async (selectedModel, context, options) => {
    const startedAt = Date.now();
    let status = 0;
    const source = await models.streamSimple(selectedModel, context, {
      ...options,
      sessionId: telemetry.sessionId,
      onResponse: async response => {
        status = response.status;
        await options?.onResponse?.(response, selectedModel);
      },
    });
    return _projectPiProviderTelemetry(source, selectedModel, startedAt, () => status, telemetry);
  };
  return {
    model,
    streamFn,
    effectiveBaseUrl: pendingCredential.baseUrl ?? profile.baseUrl,
  };
}

export function _projectPiProviderTelemetry(
  source: Awaited<ReturnType<PiKernelRunInput['streamFn']>>,
  model: Model<Api>,
  startedAt: number,
  readStatus: () => number,
  telemetry: {
    traceId: string;
    sessionId?: string;
    record: (telemetry: ProviderCallTelemetry) => Promise<void>;
  },
) {
  const projected = createAssistantMessageEventStream();
  void (async () => {
    let terminal: Extract<AssistantMessageEvent, { type: 'done' | 'error' }> | undefined;
    for await (const event of source) {
      projected.push(event);
      if (event.type === 'done' || event.type === 'error') terminal = event;
    }
    if (!terminal) return;
    const message = terminal.type === 'done' ? terminal.message : terminal.error;
    await telemetry.record({
      traceId: telemetry.traceId,
      sessionId: telemetry.sessionId,
      provider: model.provider,
      model: model.id,
      endpoint: `pi:${model.api}`,
      method: 'POST',
      stream: true,
      requestPayloadSize: 0,
      status: terminal.type === 'done' ? readStatus() || 200 : readStatus(),
      durationMs: Date.now() - startedAt,
      ...(terminal.type === 'error' ? {
        errorCode: terminal.reason === 'aborted' ? 'PROVIDER_ABORTED' : 'PROVIDER_STREAM_ERROR',
        errorMessage: message.errorMessage?.slice(0, 500),
      } : {}),
      usage: { promptTokens: message.usage.input, completionTokens: message.usage.output },
    }).catch(() => undefined);
  })();
  return projected;
}

function assertCredential(
  profile: ModelProfile,
  credential: { apiKey?: string; baseUrl?: string },
): void {
  if (!credential.apiKey && !isLoopback(credential.baseUrl ?? profile.baseUrl)) {
    throw new Error(`Provider '${profile.provider}' has no LOS-resolved credential for Pi`);
  }
}

async function resolveLosCredential(provider: string): Promise<{ apiKey?: string; baseUrl?: string }> {
  const configured = getProviderConfig(provider);
  if (configured.apiKey) return { apiKey: configured.apiKey, baseUrl: configured.baseUrl };
  if (provider === 'xai' && configured.authMode === 'oauth') {
    const resolved = await resolveXaiOAuthCredential();
    return { apiKey: resolved.apiKey, baseUrl: resolved.baseUrl };
  }
  if (configured.baseUrl && isLoopback(configured.baseUrl)) return { baseUrl: configured.baseUrl };
  throw new Error(`Provider '${provider}' has no LOS-resolved credential for Pi`);
}

function toPiApi(profile: ModelProfile): Api {
  if (profile.protocol === 'anthropic') return 'anthropic-messages';
  if (profile.apiShape === 'openai-responses') return 'openai-responses';
  if (profile.apiShape === 'openai-chat-completions') return 'openai-completions';
  throw new Error(`Pi does not support LOS API shape ${profile.apiShape}`);
}

function apiImplementation(api: Api): ProviderStreams {
  if (api === 'anthropic-messages') return anthropicMessagesApi();
  if (api === 'openai-responses') return openAIResponsesApi();
  if (api === 'openai-completions') return openAICompletionsApi();
  throw new Error(`Pi API implementation is unavailable for ${api}`);
}

function toPiToolCatalog(setup: ReturnType<typeof setupAgentRun>): PiKernelToolDescriptor[] {
  return setup.tools.getDefinitions().flatMap(definition => {
    const fn = definition.function;
    if (fn.name === 'spawn_agent') return [];
    return [{
      name: fn.name,
      description: fn.description,
      parameters: fn.parameters,
      parallelizable: setup.tools.getCapability(fn.name)?.parallelizable === true,
    }];
  });
}

function toPiMessages(messages: Message[], model: Model<Api>, now: (() => Date) | undefined): AgentMessage[] {
  const timestamp = () => (now ?? (() => new Date()))().getTime();
  const toolNames = new Map<string, string>();
  const mapped: AgentMessage[] = [];
  for (const message of messages) {
    if (message.role === 'system') continue;
    if (message.role === 'user') {
      mapped.push({ role: 'user', content: message.content, timestamp: timestamp() });
      continue;
    }
    if (message.role === 'assistant') {
      const calls = (message.tool_calls ?? []).map(call => {
        toolNames.set(call.id, call.function.name);
        return {
          type: 'toolCall' as const,
          id: call.id,
          name: call.function.name,
          arguments: parseArguments(call.function.arguments, call.id),
        };
      });
      mapped.push({
        role: 'assistant',
        content: [...(message.content ? [{ type: 'text' as const, text: message.content }] : []), ...calls],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: emptyUsage(),
        stopReason: calls.length ? 'toolUse' as const : 'stop' as const,
        timestamp: timestamp(),
      });
      continue;
    }
    const toolCallId = required(message.tool_call_id, 'tool_call_id');
    const toolName = toolNames.get(toolCallId);
    if (!toolName) throw new Error(`Cannot map LOS tool result ${toolCallId} without its assistant tool call`);
    mapped.push({
      role: 'toolResult',
      toolCallId,
      toolName,
      content: [{ type: 'text', text: message.content }],
      isError: false,
      timestamp: timestamp(),
    });
  }
  return mapped;
}

function toPiModelOptions(config: AgentConfig): PiKernelRunInput['modelOptions'] {
  const settings = config.modelSettings;
  if (settings?.topP !== undefined || settings?.presencePenalty !== undefined || settings?.frequencyPenalty !== undefined) {
    throw new Error('Pi kernel does not yet map LOS topP or penalty model settings');
  }
  if (settings?.thinking === 'disabled' || settings?.reasoningEffort === 'none') {
    throw new Error('Pi kernel does not yet map explicit reasoning disablement');
  }
  return {
    temperature: settings?.temperature,
    maxTokens: settings?.maxTokens,
    reasoning: settings?.reasoningEffort,
  };
}

function assertSupportedConfig(config: AgentConfig): void {
  if (config.providerFallback) throw new Error('Pi kernel provider fallback mapping is not implemented');
  if (config.architectEditor?.enabled) throw new Error('Pi kernel architect-editor mapping is not implemented');
  if (config.contextCompression?.enabled) throw new Error('Pi kernel context compression mapping is not implemented');
}

async function unsupportedChildRunner(): Promise<AgentResult> {
  throw new Error('Pi kernel child-agent execution is not enabled');
}

function readSystemPrompt(messages: Message[]): string {
  return messages.find(message => message.role === 'system')?.content ?? '';
}

function parseArguments(value: string, callId: string): Record<string, unknown> {
  try {
    const parsed = value ? JSON.parse(value) : {};
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('arguments must be an object');
    return parsed as Record<string, unknown>;
  } catch (error) {
    throw new Error(`Cannot map LOS tool call ${callId}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function emptyUsage() {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function required(value: string | undefined, field: string): string {
  if (!value?.trim()) throw new Error(`Pi kernel requires ${field}`);
  return value;
}

function isLoopback(baseUrl: string): boolean {
  try {
    const host = new URL(baseUrl).hostname;
    return host === 'localhost' || host === '127.0.0.1' || host === '::1';
  } catch {
    return false;
  }
}
