/**
 * @los/agent/loop — ReAct agent execution loop.
 *
 * Inspired by pi's agent-core and Codex's exec mode.
 * Flow: user prompt → build messages → LLM call → tool execution → loop → text response.
 */

import { getLogger } from '@los/infra/logger';
import { createProvider, type Provider, type Message, type ToolCall } from './providers/index.js';
import {
  createToolRegistry,
  registerBuiltinTools,
  READ_ONLY_BUILTIN_TOOLS,
  type ToolRegistry,
} from './tools/registry.js';
import { createSpawnAgentRunner, registerSpawnAgentTool } from './tools/agent-tools.js';
import {
  appendSessionEvent,
  ensureSessionEventStore,
  type SessionEventRecord,
  type SessionEventUsage,
  type SessionEventWrite,
} from './session-events.js';

const log = getLogger('agent');

// ── Types ───────────────────────────────────────────────

export interface AgentConfig {
  sessionId?: string;
  provider?: string;
  initialMessages?: Message[];
  maxLoops?: number;
  systemPrompt?: string;
  workspaceRoot?: string;
  toolMode?: 'all' | 'project-write' | 'read-only';
  allowedTools?: readonly string[];
  toolRetry?: {
    maxAttempts?: number;
    baseDelayMs?: number;
    maxDelayMs?: number;
  };
  signal?: AbortSignal;
  onSessionEvent?: (event: SessionEventRecord) => void | Promise<void>;
  onTurn?: (turn: TurnSummary) => void;
  onToolCall?: (tool: string, args: Record<string, unknown>) => void;
}

export interface TurnSummary {
  loopCount: number;
  text: string;
  toolCalls: ToolCall[];
  toolResults: string[];
  reasoningContent?: string;
}

export interface AgentResult {
  text: string;
  turns: TurnSummary[];
  loopCount: number;
  totalTokens: { prompt: number; completion: number };
  messages: Message[];
}

// ── System Prompt ───────────────────────────────────────

const DEFAULT_SYSTEM = `You are a helpful coding assistant with access to tools for reading, writing, patching, spawning child agents, and executing code.
You can: read files (read_file), write files (write_file), patch files (preview_patch, apply_patch, edit_file), list directories (list_directory), spawn constrained child agents (spawn_agent), and run shell commands (run_shell).

Rules:
- Read files before editing them
- Prefer preview_patch/apply_patch/edit_file for focused changes instead of whole-file overwrites
- Use absolute or relative paths within the workspace
- For shell commands, be specific — use exact paths
- When you're done, provide a clear summary
- If you're unsure about something, ask instead of guessing`;

const READ_ONLY_SYSTEM = `You are a helpful coding assistant with read-only access to a workspace.
You can: read files (read_file) and list directories (list_directory).

Rules:
- Inspect files before making claims about the code
- Do not claim to edit files, run shell commands, or execute tests in this mode
- Use absolute or relative paths within the workspace
- When you're done, provide a clear summary with evidence and next steps
- If you're unsure about something, ask instead of guessing`;

// ── Core Loop ───────────────────────────────────────────

export async function runAgent(
  prompt: string,
  config: AgentConfig = {},
): Promise<AgentResult> {
  const maxLoops = config.maxLoops ?? 20;
  const provider = createProvider(config.provider);
  const toolMode = config.toolMode ?? 'project-write';
  const systemPrompt = config.systemPrompt ?? getDefaultSystemPrompt(toolMode);
  const allowedTools = resolveAllowedTools(config.allowedTools, toolMode);
  const policy = resolveToolPolicy(toolMode, config.toolRetry);
  const signal = config.signal;

  // Set up tools
  const tools = createToolRegistry({ allowedTools, policy });
  registerBuiltinTools(tools, { workspaceRoot: config.workspaceRoot });
  registerSpawnAgentTool(tools, createSpawnAgentRunner({
    runAgent,
    sessionId: config.sessionId,
    provider: config.provider,
    workspaceRoot: config.workspaceRoot,
    toolRetry: config.toolRetry,
    signal,
    onSessionEvent: config.onSessionEvent,
  }));

  const toolDefs = tools.getDefinitions();
  const toolNames = tools.list();
  const emitEvent = createEventEmitter(config.sessionId, config.onSessionEvent);

  // Build initial messages
  const messages = buildInitialMessages(prompt, systemPrompt, config.initialMessages);

  const turns: TurnSummary[] = [];
  let totalPromptTokens = 0;
  let totalCompletionTokens = 0;

  log.info(`Agent starting — maxLoops=${maxLoops}, provider=${provider.name}`);
  await emitEvent({
    type: 'session.started',
    payload: {
      promptPreview: previewText(prompt),
      promptLength: prompt.length,
      provider: provider.name,
      requestedProvider: config.provider ?? null,
      workspaceRoot: config.workspaceRoot ?? null,
      toolMode,
      allowedTools,
      toolPolicy: policy,
      maxLoops,
    },
  });
  await emitEvent({
    type: 'tool.catalog',
    payload: {
      count: toolNames.length,
      tools: toolNames,
    },
  });

  for (let i = 0; i < maxLoops; i++) {
    assertNotAborted(signal);
    log.debug(`Turn ${i + 1}/${maxLoops}`);
    await emitEvent({
      type: 'model.turn.started',
      turn: i + 1,
      model: provider.name,
      payload: {
        provider: provider.name,
        messageCount: messages.length,
        offeredToolCount: toolDefs.length,
      },
    });

    const modelStartedAt = Date.now();
    const res = await withAbort(
      provider.chat(messages, toolDefs.length > 0 ? toolDefs : undefined, { signal }),
      signal,
    );
    const modelDurationMs = Date.now() - modelStartedAt;
    assertNotAborted(signal);

    totalPromptTokens += res.usage.promptTokens;
    totalCompletionTokens += res.usage.completionTokens;
    await emitEvent({
      type: 'model.response',
      turn: i + 1,
      model: res.model,
      cacheHit: inferCacheHit(res.usage),
      usage: normalizeUsage(res.usage),
      payload: {
        provider: provider.name,
        durationMs: modelDurationMs,
        textPreview: previewText(res.text),
        textLength: res.text.length,
        reasoningPreview: res.reasoningContent ? previewText(res.reasoningContent) : undefined,
        reasoningLength: res.reasoningContent?.length ?? 0,
        toolCallCount: res.toolCalls.length,
        toolCalls: summarizeToolCalls(res.toolCalls),
      },
    });

    // Add assistant message
    const assistantMsg: Message = {
      role: 'assistant',
      content: res.text,
      tool_calls: res.toolCalls.length > 0 ? res.toolCalls : undefined,
    };
    messages.push(assistantMsg);

    // If no tool calls, we're done
    if (res.toolCalls.length === 0) {
      const turn: TurnSummary = {
        loopCount: i + 1,
        text: res.text,
        toolCalls: [],
        toolResults: [],
        reasoningContent: res.reasoningContent,
      };
      turns.push(turn);
      config.onTurn?.(turn);

      log.info(`Agent finished — ${i + 1} turns, ${totalPromptTokens + totalCompletionTokens} tokens`);
      await emitEvent({
        type: 'session.completed',
        turn: i + 1,
        payload: {
          loopCount: i + 1,
          totalTokens: totalPromptTokens + totalCompletionTokens,
          totalPromptTokens,
          totalCompletionTokens,
        },
      });
      return {
        text: res.text,
        turns,
        loopCount: i + 1,
        totalTokens: { prompt: totalPromptTokens, completion: totalCompletionTokens },
        messages,
      };
    }

    // Execute tool calls
    const toolResults: string[] = [];
    for (const tc of res.toolCalls) {
      assertNotAborted(signal);
      const fn = tc.function;
      log.debug(`Tool call: ${fn.name}(${fn.arguments.slice(0, 100)})`);
      let args: Record<string, unknown>;
      try {
        args = JSON.parse(fn.arguments) as Record<string, unknown>;
      } catch (err: any) {
        await emitEvent({
          type: 'tool.result',
          turn: i + 1,
          toolName: fn.name,
          parentEventId: undefined,
          payload: {
            callId: tc.id,
            ok: false,
            durationMs: 0,
            contentPreview: '',
            contentLength: 0,
            errorPreview: `Invalid tool arguments: ${err?.message ?? String(err)}`,
          },
        });
        throw err;
      }
      config.onToolCall?.(fn.name, args);
      const callEvent = await emitEvent({
        type: 'tool.call',
        turn: i + 1,
        toolName: fn.name,
        payload: {
          callId: tc.id,
          args,
          argsLength: fn.arguments.length,
        },
      });

      const capability = tools.getCapability(fn.name);
      const planEvent = await emitEvent({
        type: 'tool.planned',
        turn: i + 1,
        toolName: fn.name,
        parentEventId: callEvent?.id,
        payload: {
          callId: tc.id,
          capability: summarizeCapability(capability),
          policy,
          argsLength: fn.arguments.length,
        },
      });

      const decision = tools.evaluateTool(fn.name);
      const decisionEvent = await emitEvent({
        type: decision.allowed ? 'tool.approved' : 'tool.denied',
        turn: i + 1,
        toolName: fn.name,
        parentEventId: planEvent?.id ?? callEvent?.id,
        payload: {
          callId: tc.id,
          allowed: decision.allowed,
          reasonCode: decision.allowed ? undefined : decision.reasonCode,
          reason: decision.allowed ? undefined : decision.reason,
          capability: summarizeCapability(decision.capability),
          policy: decision.policy,
        },
      });

      const toolStartedAt = Date.now();
      const result = decision.allowed
        ? await withAbort(
            tools.execute({
              name: fn.name,
              arguments: args,
            }),
            signal,
          )
        : { content: '', error: decision.reason };
      const toolDurationMs = Date.now() - toolStartedAt;

      const content = result.error ?? result.content;
      toolResults.push(content);
      await emitEvent({
        type: 'tool.result',
        turn: i + 1,
        toolName: fn.name,
        parentEventId: decisionEvent?.id ?? callEvent?.id,
        payload: {
          callId: tc.id,
          ok: !result.error,
          denied: !decision.allowed,
          reasonCode: decision.allowed ? undefined : decision.reasonCode,
          durationMs: toolDurationMs,
          attempts: result.attempts ?? 1,
          retried: result.retried ?? false,
          retryErrors: result.retryErrors ?? [],
          contentPreview: previewText(content),
          contentLength: content.length,
          errorPreview: result.error ? previewText(result.error) : undefined,
        },
      });

      messages.push({
        role: 'tool',
        content: content.slice(0, 8000), // Truncate very long results
        tool_call_id: tc.id,
      });
    }

    const turn: TurnSummary = {
      loopCount: i + 1,
      text: res.text,
      toolCalls: res.toolCalls,
      toolResults,
    };
    turns.push(turn);
    config.onTurn?.(turn);
  }

  // Max loops reached — ask model for final summary
  messages.push({
    role: 'user',
    content: 'You have reached the maximum number of turns. Please provide a final summary of what you accomplished and what remains to be done.',
  });

  assertNotAborted(signal);
  const finalRes = await withAbort(provider.chat(messages, undefined, { signal }), signal);
  totalPromptTokens += finalRes.usage.promptTokens;
  totalCompletionTokens += finalRes.usage.completionTokens;

  log.warn(`Agent hit maxLoops (${maxLoops})`);
  await emitEvent({
    type: 'session.completed',
    turn: maxLoops + 1,
    payload: {
      loopCount: maxLoops + 1,
      totalTokens: totalPromptTokens + totalCompletionTokens,
      totalPromptTokens,
      totalCompletionTokens,
      forcedSummary: true,
    },
  });

  return {
    text: finalRes.text,
    turns,
    loopCount: maxLoops + 1,
    totalTokens: { prompt: totalPromptTokens, completion: totalCompletionTokens },
    messages,
  };
}

function createEventEmitter(
  sessionId: string | undefined,
  onSessionEvent: AgentConfig['onSessionEvent'],
) {
  return async (event: Omit<SessionEventWrite, 'sessionId'>): Promise<SessionEventRecord | null> => {
    if (!sessionId) return null;
    try {
      await ensureSessionEventStore();
      const written = await appendSessionEvent({ sessionId, ...event });
      try {
        await onSessionEvent?.(written);
      } catch (err: any) {
        log.warn(`Session event callback failed: ${err.message ?? String(err)}`);
      }
      return written;
    } catch (err: any) {
      log.warn(`Session event write failed: ${err.message ?? String(err)}`);
      return null;
    }
  };
}

function buildInitialMessages(
  prompt: string,
  systemPrompt: string,
  initialMessages: Message[] | undefined,
): Message[] {
  const messages = initialMessages?.length
    ? initialMessages.map(message => ({ ...message }))
    : [{ role: 'system' as const, content: systemPrompt }];
  if (!messages.some(message => message.role === 'system')) {
    messages.unshift({ role: 'system', content: systemPrompt });
  }
  messages.push({ role: 'user', content: prompt });
  return messages;
}

function normalizeUsage(usage: {
  promptTokens: number;
  completionTokens: number;
  cacheHitTokens?: number;
  cacheMissTokens?: number;
  totalTokens?: number;
}): SessionEventUsage {
  return {
    promptTokens: usage.promptTokens,
    completionTokens: usage.completionTokens,
    cacheHitTokens: usage.cacheHitTokens ?? 0,
    cacheMissTokens: usage.cacheMissTokens ?? 0,
    totalTokens: usage.totalTokens ?? usage.promptTokens + usage.completionTokens,
  };
}

function inferCacheHit(usage: { cacheHitTokens?: number; cacheMissTokens?: number }): boolean | undefined {
  const hit = usage.cacheHitTokens ?? 0;
  const miss = usage.cacheMissTokens ?? 0;
  if (hit === 0 && miss === 0) return undefined;
  return hit > 0;
}

function summarizeToolCalls(toolCalls: ToolCall[]): Array<Record<string, unknown>> {
  return toolCalls.map(tc => ({
    id: tc.id,
    name: tc.function.name,
    argsPreview: previewText(tc.function.arguments, 1000),
    argsLength: tc.function.arguments.length,
  }));
}

function previewText(text: string, max = 8000): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}... [truncated ${text.length - max} chars]`;
}

function summarizeCapability(capability: ReturnType<ToolRegistry['getCapability']> | undefined): Record<string, unknown> | null {
  if (!capability) return null;
  return {
    name: capability.name,
    riskLevel: capability.riskLevel,
    permissions: capability.permissions,
    timeoutMs: capability.timeoutMs,
    retryable: capability.retryable,
    idempotent: capability.idempotent,
    costLevel: capability.costLevel,
    sideEffect: capability.sideEffect,
    sandboxRequired: capability.sandboxRequired,
    needsApproval: capability.needsApproval,
    tags: capability.tags,
  };
}

function resolveAllowedTools(
  explicitAllowedTools: readonly string[] | undefined,
  toolMode: 'all' | 'project-write' | 'read-only',
): readonly string[] | undefined {
  const selected = explicitAllowedTools ? [...new Set(explicitAllowedTools)] : undefined;
  if (toolMode !== 'read-only') {
    return selected;
  }

  const readOnly = new Set<string>(READ_ONLY_BUILTIN_TOOLS);
  if (!selected) {
    return [...readOnly];
  }

  return selected.filter(tool => readOnly.has(tool));
}

function resolveToolPolicy(
  toolMode: 'all' | 'project-write' | 'read-only',
  retry: AgentConfig['toolRetry'] | undefined,
) {
  const normalizedRetry = normalizeToolRetry(retry);
  if (toolMode === 'read-only') {
    return {
      maxRiskLevel: 'L0' as const,
      allowWrites: false,
      sandboxAvailable: false,
      retry: normalizedRetry,
    };
  }
  if (toolMode === 'project-write') {
    return {
      maxRiskLevel: 'L1' as const,
      allowWrites: true,
      sandboxAvailable: false,
      retry: normalizedRetry,
    };
  }
  return {
    maxRiskLevel: 'L2' as const,
    allowWrites: true,
    sandboxAvailable: true,
    retry: normalizedRetry,
  };
}

function normalizeToolRetry(retry: AgentConfig['toolRetry'] | undefined) {
  if (!retry) return undefined;
  return {
    maxAttempts: retry.maxAttempts,
    baseDelayMs: retry.baseDelayMs,
    maxDelayMs: retry.maxDelayMs,
  };
}

function getDefaultSystemPrompt(toolMode: 'all' | 'project-write' | 'read-only'): string {
  if (toolMode === 'read-only') return READ_ONLY_SYSTEM;
  if (toolMode === 'project-write') {
    return `You are a helpful coding assistant with project-write access to a workspace.
You can: read files (read_file), write files (write_file), and list directories (list_directory).
You can also manage the project planning ledger with todo_list, todo_create, todo_update, todo_archive, todo_reopen, and todo_link_dependency.

Rules:
- Read files before editing them
- Limit changes to the provided workspace root
- Do not run shell commands in this mode
- For todo writes, preserve tenantId/projectId/requestId/traceId when available
- When you're done, provide a clear summary with the files changed
- If you're unsure about something, ask instead of guessing`;
  }
  return DEFAULT_SYSTEM;
}

function assertNotAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  throw abortErrorFromSignal(signal);
}

function withAbort<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortErrorFromSignal(signal));

  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortErrorFromSignal(signal));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      value => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      err => {
        signal.removeEventListener('abort', onAbort);
        reject(err);
      },
    );
  });
}

function abortErrorFromSignal(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason;
  const message = typeof signal.reason === 'string' ? signal.reason : 'Operation aborted';
  const err = new Error(message);
  err.name = 'AbortError';
  return err;
}
