/**
 * @los/agent/loop — ReAct agent execution loop.
 *
 * Inspired by pi's agent-core and Codex's exec mode.
 * Flow: user prompt → build messages → LLM call → tool execution → loop → text response.
 */

import { getLogger } from '@los/infra/logger';
import { createProvider, type Provider, type Message, type ProviderDelta, type ToolCall } from './providers/index.js';
import { summarizeModelProfile } from './model-profiles.js';
import type { ModelSettings } from './model-settings.js';
import {
  createToolRegistry,
  registerBuiltinTools,
  READ_ONLY_BUILTIN_TOOLS,
  type ToolRegistry,
} from './tools/registry.js';
import type { MCPServerConfig, MCPServerRegistryRecord } from './tools/mcp-client.js';
import { listMCPServers } from './mcp-servers.js';
import { createSpawnAgentRunner, registerSpawnAgentTool } from './tools/agent-tools.js';
import {
  type SessionEventRecord,
  type SessionEventUsage,
  type SessionEventWrite,
} from './session-events.js';
import { createEventEmitter } from './event-emitter.js';

const log = getLogger('agent');

// ── Types ───────────────────────────────────────────────

export interface AgentConfig {
  sessionId?: string;
  provider?: string;
  model?: string;
  modelSettings?: ModelSettings;
  initialMessages?: Message[];
  maxLoops?: number;
  systemPrompt?: string;
  workspaceRoot?: string;
  tenantId?: string;
  projectId?: string;
  userId?: string;
  nodeId?: string;
  requestId?: string;
  traceId?: string;
  toolMode?: 'all' | 'project-write' | 'read-only';
  allowedTools?: readonly string[];
  toolRetry?: {
    maxAttempts?: number;
    baseDelayMs?: number;
    maxDelayMs?: number;
  };
  signal?: AbortSignal;
  maxContextTokens?: number;
  contextCompression?: ContextCompressionConfig;
  mcpServers?: MCPServerConfig[];
  onToolCallState?: (transition: ToolCallStateTransition) => void | Promise<void>;
  onSessionEvent?: (event: SessionEventRecord) => void | Promise<void>;
  onTurn?: (turn: TurnSummary) => void;
  onToolCall?: (tool: string, args: Record<string, unknown>) => void;
  onModelDelta?: (delta: AgentModelDelta) => void | Promise<void>;
  onCheckpoint?: (state: CheckpointState) => void | Promise<void>;
}

export interface AgentModelDelta extends ProviderDelta {
  turn: number;
  provider: string;
}

export interface TurnSummary {
  loopCount: number;
  text: string;
  toolCalls: ToolCall[];
  toolResults: string[];
  reasoningContent?: string;
}

export interface CheckpointState {
  messages: Message[];
  turns: TurnSummary[];
}

export interface AgentResult {
  text: string;
  turns: TurnSummary[];
  loopCount: number;
  totalTokens: { prompt: number; completion: number };
  messages: Message[];
}

export interface ContextCompressionConfig {
  enabled?: boolean;           // default true when maxContextTokens is set
  warningRatio?: number;       // start compressing at this % of budget (default 0.80)
  aggressiveRatio?: number;    // aggressive compression (default 0.88)
  emergencyRatio?: number;     // hard truncation (default 0.95)
}

export interface ToolCallStateTransition {
  callId: string;
  toolName: string;
  state: 'requested' | 'approved' | 'denied' | 'running' | 'succeeded' | 'failed' | 'retrying';
  turn: number;
  input?: Record<string, unknown>;
  outputSummary?: string;
  error?: string;
  durationMs?: number;
  attempt?: number;
  maxAttempts?: number;
  idempotent?: boolean;
  retryPolicy?: Record<string, unknown>;
}

// ── System Prompt ───────────────────────────────────────

const DEFAULT_SYSTEM = `You are a helpful coding assistant with access to tools for reading, writing, searching, patching, spawning child agents, and executing code.
You can: read files (read_file), write files (write_file), patch files (preview_patch, apply_patch, edit_file), search code (search_content, search_files, glob), analyze code (get_symbols, find_in_code), inspect directories (list_directory, directory_tree, get_file_info), create directories (create_directory), delete files (delete_file), spawn constrained child agents (spawn_agent), and run shell commands (run_shell).

Rules:
- Read files before editing them
- Prefer preview_patch/apply_patch/edit_file for focused changes instead of whole-file overwrites
- Use absolute or relative paths within the workspace
- For shell commands, be specific — use exact paths
- When you're done, provide a clear summary
- If you're unsure about something, ask instead of guessing`;

const READ_ONLY_SYSTEM = `You are a helpful coding assistant with read-only access to a workspace.
You can: read files (read_file), search code (search_content, search_files, glob), analyze code (get_symbols, find_in_code), inspect directories (list_directory, directory_tree, get_file_info).

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
  const provider = createProvider(config.provider, { model: config.model });
  const modelProfile = summarizeModelProfile(provider.profile);
  const toolMode = config.toolMode ?? 'project-write';
  const systemPrompt = config.systemPrompt ?? getDefaultSystemPrompt(toolMode);
  const allowedTools = resolveAllowedTools(config.allowedTools, toolMode);
  const policy = resolveToolPolicy(toolMode, config.toolRetry);
  const signal = config.signal;

  // Load enabled MCP servers from the persistent registry
  let mcpRegistryRecords: MCPServerRegistryRecord[] | undefined;
  if (config.tenantId || config.projectId) {
    try {
      const registryServers = await listMCPServers({
        tenantId: config.tenantId,
        projectId: config.projectId,
        enabled: true,
      });
      mcpRegistryRecords = registryServers
        .filter(s => s.status !== 'disabled')
        .map(s => ({
          id: s.id,
          command: s.command,
          args: s.args,
          url: s.url,
          env: s.env,
        }));
    } catch (err: any) {
      log.warn(`Failed to load MCP servers from registry: ${err.message ?? String(err)}`);
    }
  }

  // Set up tools
  const tools = createToolRegistry({ allowedTools, policy });
  const mcpCleanup = await registerBuiltinTools(tools, {
    workspaceRoot: config.workspaceRoot,
    mcpServers: config.mcpServers,
    mcpRegistryRecords,
  });
  registerSpawnAgentTool(tools, createSpawnAgentRunner({
    runAgent,
    sessionId: config.sessionId,
    provider: config.provider,
    model: config.model,
    modelSettings: config.modelSettings,
    workspaceRoot: config.workspaceRoot,
    toolRetry: config.toolRetry,
    signal,
    onSessionEvent: config.onSessionEvent,
  }));

  const toolDefs = tools.getDefinitions();
  const toolNames = tools.list();
  const emitEvent = createEventEmitter(config.sessionId, config, config.onSessionEvent);

  // Build initial messages
  const messages = buildInitialMessages(prompt, systemPrompt, config.initialMessages, config.maxContextTokens, config.contextCompression);

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
      requestedModel: config.model ?? null,
      effectiveModel: provider.profile.model,
      modelProfile,
      workspaceRoot: config.workspaceRoot ?? null,
      toolMode,
      allowedTools,
      toolPolicy: policy,
      maxLoops,
      modelSettings: config.modelSettings ?? null,
    },
  });
  await emitEvent({
    type: 'tool.catalog',
    payload: {
      count: toolNames.length,
      tools: toolNames,
    },
  });

  try {
    for (let i = 0; i < maxLoops; i++) {
    assertNotAborted(signal);
    log.debug(`Turn ${i + 1}/${maxLoops}`);
    await emitEvent({
      type: 'model.turn.started',
      turn: i + 1,
      model: provider.name,
      payload: {
        provider: provider.name,
        modelProfile,
        messageCount: messages.length,
        offeredToolCount: toolDefs.length,
      },
    });

    const modelStartedAt = Date.now();
    const res = await withAbort(
      provider.chat(messages, toolDefs.length > 0 ? toolDefs : undefined, {
        signal,
        modelSettings: config.modelSettings,
        onDelta: config.onModelDelta
          ? async (delta) => {
              await config.onModelDelta?.({ ...delta, turn: i + 1, provider: provider.name });
            }
          : undefined,
      }),
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
        modelProfile,
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
      await config.onCheckpoint?.({ messages: [...messages], turns: [...turns] });

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

      // Tool call state: requested
      await config.onToolCallState?.({
        callId: tc.id, toolName: fn.name, state: 'requested', turn: i + 1,
        input: args,
      });

      const capability = tools.getCapability(fn.name);
      const toolSource = inferToolSource(capability);

      const callEvent = await emitEvent({
        type: 'tool.call',
        turn: i + 1,
        toolName: fn.name,
        payload: {
          callId: tc.id,
          args,
          argsLength: fn.arguments.length,
          source: toolSource,
        },
      });

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
          source: toolSource,
        },
      });

      const decision = tools.evaluateTool(fn.name);

      // Tool call state: approved or denied
      await config.onToolCallState?.({
        callId: tc.id, toolName: fn.name,
        state: decision.allowed ? 'approved' : 'denied',
        turn: i + 1,
        error: decision.allowed ? undefined : decision.reason,
      });

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

      // Tool call state: running → succeeded or failed
      if (decision.allowed) {
        await config.onToolCallState?.({
          callId: tc.id, toolName: fn.name, state: 'running', turn: i + 1,
        });
      }
      await config.onToolCallState?.({
        callId: tc.id, toolName: fn.name,
        state: result.error ? 'failed' : 'succeeded',
        turn: i + 1,
        outputSummary: result.error ? undefined : previewText(result.content, 200),
        error: result.error,
        durationMs: toolDurationMs,
        attempt: result.attempts ?? 1,
      });

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
          source: toolSource,
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
    await config.onCheckpoint?.({ messages: [...messages], turns: [...turns] });

    // Mid-loop context compression
    if (config.maxContextTokens && config.maxContextTokens > 0 &&
        config.contextCompression?.enabled !== false) {
      const compressed = compressOrTrimMessages(
        messages, config.maxContextTokens, config.contextCompression,
      );
      // Only replace if compression actually reduced the message count
      if (compressed.length < messages.length) {
        messages.length = 0;
        messages.push(...compressed);
        log.debug(`Compressed context: ${compressed.length} messages (was ${messages.length + messages.length - compressed.length})`);
      }
    }
  }

  // Max loops reached — ask model for final summary
  messages.push({
    role: 'user',
    content: 'You have reached the maximum number of turns. Please provide a final summary of what you accomplished and what remains to be done.',
  });

  assertNotAborted(signal);
  const finalRes = await withAbort(provider.chat(messages, undefined, {
    signal,
    modelSettings: config.modelSettings,
    onDelta: config.onModelDelta
      ? async (delta) => {
          await config.onModelDelta?.({ ...delta, turn: maxLoops + 1, provider: provider.name });
        }
      : undefined,
  }), signal);
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
  } finally {
    await mcpCleanup();
  }
}

function buildInitialMessages(
  prompt: string,
  systemPrompt: string,
  initialMessages: Message[] | undefined,
  maxContextTokens?: number,
  compression?: ContextCompressionConfig,
): Message[] {
  const messages = initialMessages?.length
    ? initialMessages.map(message => ({ ...message }))
    : [{ role: 'system' as const, content: systemPrompt }];
  if (!messages.some(message => message.role === 'system')) {
    messages.unshift({ role: 'system', content: systemPrompt });
  }
  messages.push({ role: 'user', content: prompt });

  if (maxContextTokens && maxContextTokens > 0) {
    const compressed = compressOrTrimMessages(messages, maxContextTokens, compression);
    return compressed;
  }
  return messages;
}

// ── Token Estimation ────────────────────────────────────

/**
 * Rough token estimator — chars/4 heuristic with a penalty for non-ASCII.
 * Accurate enough for context-window budgeting (±15%).
 * A proper tiktoken integration would replace this for exact counts.
 */
function estimateTokens(text: string): number {
  let tokens = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (code <= 0x7f) {
      // ASCII: ~4 chars per token
      tokens += 0.25;
    } else if (code <= 0x7ff) {
      // 2-byte UTF-8: ~2 chars per token
      tokens += 0.5;
    } else if (code <= 0xffff) {
      // 3-byte UTF-8: ~1 char per token
      tokens += 1.0;
    } else {
      // 4-byte UTF-8 (emoji etc.): 1-2 tokens
      tokens += 1.5;
    }
  }
  return Math.ceil(tokens);
}

function estimateMessageTokens(msg: Message): number {
  let tokens = estimateTokens(msg.content);
  // Tool calls add overhead
  if (msg.tool_calls) {
    for (const tc of msg.tool_calls) {
      tokens += estimateTokens(tc.function.name) + estimateTokens(tc.function.arguments) + 4;
    }
  }
  // Role overhead (~3 tokens)
  return tokens + 3;
}

/**
 * Trim messages to fit within a token budget.
 * - System message is always preserved (truncated if necessary).
 * - Oldest non-system messages are removed first.
 * - At minimum, system + latest user message are kept.
 */
function trimMessagesToBudget(messages: Message[], budget: number): Message[] {
  const systemIdx = messages.findIndex(m => m.role === 'system');
  const systemMsg = systemIdx >= 0 ? messages[systemIdx] : null;

  // Build the result: start from the end (most recent), work backwards
  const nonSystem = systemIdx >= 0
    ? [...messages.slice(0, systemIdx), ...messages.slice(systemIdx + 1)]
    : [...messages];

  // Always keep the last message (the current prompt)
  const last = nonSystem[nonSystem.length - 1];
  if (!last) {
    // Only system message exists — truncate it if needed
    if (systemMsg) {
      const sysTokens = estimateMessageTokens(systemMsg);
      if (sysTokens > budget) {
        return [{ ...systemMsg, content: truncateContent(systemMsg.content, budget - 10) }];
      }
      return [systemMsg];
    }
    return [];
  }

  let used = estimateMessageTokens(last);
  if (systemMsg) used += estimateMessageTokens(systemMsg);
  const kept: Message[] = [last];

  // Add older messages while under budget
  for (let i = nonSystem.length - 2; i >= 0; i--) {
    const msgTokens = estimateMessageTokens(nonSystem[i]!);
    if (used + msgTokens <= budget) {
      used += msgTokens;
      kept.unshift(nonSystem[i]!);
    } else {
      break;
    }
  }

  // If even system + last message exceeds budget, truncate the last message
  if (systemMsg) {
    const sysTokens = estimateMessageTokens(systemMsg);
    if (sysTokens + estimateMessageTokens(last) > budget) {
      const available = Math.max(50, budget - sysTokens);
      kept[kept.length - 1] = { ...last, content: truncateContent(last.content, available) };
    }
    kept.unshift(systemMsg);
  }

  return kept;
}

function truncateContent(content: string, tokenBudget: number): string {
  // Rough: 4 chars ≈ 1 token, leave some margin
  const maxChars = Math.max(50, tokenBudget * 3);
  if (content.length <= maxChars) return content;
  return content.slice(0, maxChars) + '\n[...truncated]';
}

// ── Context Compression ─────────────────────────────────

/**
 * Three-tier context compression:
 *   warning    (80%): compress old turns into brief summaries
 *   aggressive (88%): compress old turns into terse summaries
 *   emergency  (95%): hard truncation — drop oldest messages
 *
 * Preserves the system message and the most recent turns intact.
 * Compressed turns become a synthetic "user" message summarizing earlier work.
 */
function compressOrTrimMessages(
  messages: Message[],
  budget: number,
  compression?: ContextCompressionConfig,
): Message[] {
  const enabled = compression?.enabled !== false;
  const warningRatio = compression?.warningRatio ?? 0.80;
  const aggressiveRatio = compression?.aggressiveRatio ?? 0.88;
  const emergencyRatio = compression?.emergencyRatio ?? 0.95;

  const totalTokens = messages.reduce((sum, m) => sum + estimateMessageTokens(m), 0);
  if (totalTokens <= budget) return messages; // Under budget — no action needed

  const systemIdx = messages.findIndex(m => m.role === 'system');

  // Emergency: hard truncation
  if (totalTokens > budget * emergencyRatio || !enabled) {
    return trimMessagesToBudget(messages, budget);
  }

  // Warning / Aggressive: compress instead of drop
  const ratio = totalTokens / budget;
  const summaryBudget = Math.floor(budget * (ratio > aggressiveRatio ? 0.05 : 0.10));

  // Find the split point: which messages to compress?
  // Keep the most recent user message + all after it intact
  // Compress everything before that (except system)
  const nonSystem = systemIdx >= 0
    ? [...messages.slice(0, systemIdx), ...messages.slice(systemIdx + 1)]
    : [...messages];

  // Find the last user message — keep it and everything after
  let keepFrom = nonSystem.length - 1;
  for (let i = nonSystem.length - 1; i >= 0; i--) {
    if (nonSystem[i]!.role === 'user') { keepFrom = i; break; }
  }

  const toKeep = nonSystem.slice(keepFrom);
  const toCompress = nonSystem.slice(0, keepFrom);

  if (toCompress.length === 0) {
    return trimMessagesToBudget(messages, budget);
  }

  // Generate summary from compressed messages
  const summary = generateCompressionSummary(toCompress, summaryBudget, ratio > aggressiveRatio);

  // Build result: system + summary + recent messages
  const result: Message[] = [];
  if (systemIdx >= 0) result.push(messages[systemIdx]!);
  result.push({ role: 'user', content: summary });
  result.push(...toKeep);

  return result;
}

/**
 * Generate a compressed summary of old messages.
 * Extracts: turns with tool calls, key decisions, errors.
 */
function generateCompressionSummary(
  messages: Message[],
  tokenBudget: number,
  aggressive: boolean,
): string {
  const lines: string[] = ['[Compressed earlier context]'];
  lines.push('');

  let turnIdx = 0;
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]!;
    if (msg.role === 'assistant') {
      turnIdx++;
      const text = summarizeText(msg.content, aggressive ? 60 : 120);
      const tools = summarizeToolCallsForCompression(msg.tool_calls);

      if (tools.length > 0) {
        lines.push(`Turn ${turnIdx}: ${text} [Tools: ${tools.join(', ')}]`);
      } else {
        lines.push(`Turn ${turnIdx}: ${text}`);
      }
    } else if (msg.role === 'tool') {
      const result = summarizeText(msg.content, aggressive ? 30 : 60);
      if (result) {
        const last = lines[lines.length - 1] ?? '';
        if (last.startsWith(`Turn ${turnIdx}:`)) {
          lines[lines.length - 1] = last + ` → ${result}`;
        }
      }
    }
  }

  if (turnIdx === 0) {
    lines.push('(no assistant turns to summarize)');
  }

  const full = lines.join('\n');
  if (estimateTokens(full) <= tokenBudget) return full;
  return full.slice(0, tokenBudget * 3) + '\n[...summary truncated]';
}

function summarizeText(text: string, maxLen: number): string {
  const cleaned = text
    .replace(/\n+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (cleaned.length <= maxLen) return cleaned;
  return cleaned.slice(0, maxLen) + '...';
}

function summarizeToolCallsForCompression(toolCalls?: ToolCall[]): string[] {
  if (!toolCalls || toolCalls.length === 0) return [];
  return toolCalls.map(tc => tc.function.name);
}

/**
 * Determine the tool source for event metadata.
 * Returns 'mcp' for MCP-registered tools, 'builtin' for everything else.
 */
function inferToolSource(capability: ReturnType<ToolRegistry['getCapability']>): string {
  if (capability?.tags?.includes('mcp')) return 'mcp';
  if (capability?.tags?.includes('agent')) return 'spawn_agent';
  return 'builtin';
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
You can: read files (read_file), write files (write_file), search code (search_content, search_files, glob), analyze code (get_symbols, find_in_code), inspect directories (list_directory, directory_tree, get_file_info), create directories (create_directory), and delete files (delete_file).
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
