/**
 * OpenAI-compatible /v1/chat/completions endpoint.
 *
 * Translates OpenAI chat completions format into los chat format and runs the
 * los agent loop. Two response modes:
 *
 *  - stream:false → plain JSON completion (WeClaw HTTP agent integration):
 *      WeChat → WeClaw → HTTP POST /v1/chat/completions → los agent loop → Tool Gate + OTel
 *
 *  - stream:true → real SSE (OpenAI chat.completion.chunk wire format):
 *      per-token content deltas are relayed from the provider stream through
 *      the gateway's `model.delta` chat event, so SSE-only clients (e.g. DSH
 *      llm-pi-ai) see token-level increments directly from los — no external
 *      SSE bridge/proxy needed.
 */

import type { FastifyInstance } from 'fastify';
import type { MessageRouter } from '@los/agent/message-router';
import { runChat, type ChatRunContext, type SendEvent } from './chat-service.js';
import { getDefaultProjectId, resolveConfiguredProjectOwner } from './project-store.js';
import { getMessagePrincipal, getRequestContext } from './request-context.js';
import { getConfig } from '@los/infra/config';
import { discoverAll } from '@los/infra/discovery';

interface OpenAIChatRequest {
  model?: string;
  messages: Array<{ role: string; content: string }>;
  stream?: boolean;
  max_tokens?: number;
  temperature?: number;
}

type OpenAICompatibleRouteDependencies = {
  runChat: typeof runChat;
  getDefaultProjectId: typeof getDefaultProjectId;
  resolveConfiguredProjectOwner: typeof resolveConfiguredProjectOwner;
};

const defaultDependencies: OpenAICompatibleRouteDependencies = {
  runChat,
  getDefaultProjectId,
  resolveConfiguredProjectOwner,
};

export function registerOpenAICompatibleRoute(
  app: FastifyInstance,
  config: ReturnType<typeof import('@los/infra/config').getConfig>,
  defaultWorkspaceRoot: string,
  gatewayServiceId?: string,
  messageRouter?: MessageRouter,
  overrides: Partial<OpenAICompatibleRouteDependencies> = {},
): void {
  const dependencies = { ...defaultDependencies, ...overrides };

  // OpenAI model discovery surface: the request `model` is a LOS provider
  // name, so the catalog is the available provider set. `/providers/models`
  // (LOS-native shape) stays the detailed view; this is the wire-compatible
  // `{object:"list", data:[{id,...}]}` shape OpenAI clients expect.
  app.get('/v1/models', async (_req, reply) => {
    const names = new Set<string>();
    const discoveryReport = await discoverAll().catch(() => ({ providers: [] }));
    for (const dp of discoveryReport.providers) {
      if (dp.available && typeof dp.name === 'string' && dp.name.length > 0) names.add(dp.name);
    }
    for (const name of Object.keys(getConfig().providers ?? {})) names.add(name);
    const created = Math.floor(Date.now() / 1000);
    return reply.send({
      object: 'list',
      data: [...names].sort().map(name => ({ id: name, object: 'model', created, owned_by: 'los' })),
    });
  });

  app.post('/v1/chat/completions', async (req: any, reply: any) => {
    const body = req.body as OpenAIChatRequest;
    const context = getRequestContext(req);
    const principal = getMessagePrincipal(req);
    const sid = `chat-${body.model ?? 'openai'}-${Date.now()}`;
    const traceId = `trace-${context.requestId}`;
    const wantStream = body.stream === true;

    // OpenAI-compatible envelope identity, shared by the JSON and SSE paths.
    const completionId = `chatcmpl-${context.requestId}`;
    const created = Math.floor(Date.now() / 1000);
    const responseModel = body.model ?? 'los';
    const base = { id: completionId, created, model: responseModel };

    // Convert OpenAI messages into los prompt.
    // WeClaw often sends multi-turn history — command detection MUST use only
    // the last user turn, otherwise "#approve …" buried after history never matches.
    let systemPrompt = '';
    const userTurns: string[] = [];
    for (const msg of body.messages) {
      if (msg.role === 'system') systemPrompt += msg.content + '\n';
      else if (msg.role === 'user') userTurns.push(msg.content);
    }
    const lastUserTurn = (userTurns[userTurns.length - 1] ?? '').trim();
    const prompt = lastUserTurn || userTurns.join('\n').trim() || 'Hello';

    // Short-path IM commands (no agent loop, no long timeout).
    if (messageRouter && lastUserTurn.startsWith('#')) {
      const intent = messageRouter.resolveIntent(lastUserTurn);
      if (intent.type !== 'chat' && intent.type !== 'unknown') {
        const result = await messageRouter.route({
          sourceKind: 'wx-weclaw',
          // Single-turn only so normalizer/rawText is exactly the command line.
          messages: [{ role: 'user', content: lastUserTurn }],
          model: body.model,
        }, { principal });
        if (result.error === 'operator_required') {
          return reply.status(403).send({
            error: {
              message: result.text ?? 'Operator authorization required for this command.',
              type: 'insufficient_permissions',
              code: 'operator_required',
            },
          });
        }
        const text = result.handled
          ? (result.text ?? 'ok')
          : (result.error ?? '命令未处理');
        if (!wantStream) {
          return reply.send({
            id: completionId,
            object: 'chat.completion',
            created,
            model: responseModel,
            choices: [{
              index: 0,
              message: { role: 'assistant', content: text },
              finish_reason: result.handled ? 'stop' : 'error',
            }],
            usage: {
              prompt_tokens: lastUserTurn.length,
              completion_tokens: text.length,
              total_tokens: lastUserTurn.length + text.length,
            },
          });
        }
        // Stream the short-path result as SSE (whole result in one content chunk).
        reply.raw.writeHead(200, sseHeaders());
        writeSSEChunk(reply, { ...base, object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] });
        writeSSEChunk(reply, { ...base, object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: text }, finish_reason: null }] });
        writeSSEChunk(reply, { ...base, object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: result.handled ? 'stop' : 'error' }] });
        reply.raw.write('data: [DONE]\n\n');
        reply.raw.end();
        return;
      }
    }

    const requestedProjectId = normalizeHeader(req.headers['x-project-id']);
    const storedDefaultProjectId = dependencies.getDefaultProjectId();
    const intakeResolution = dependencies.resolveConfiguredProjectOwner({
      contextProjectId: requestedProjectId,
      defaultProjectId: storedDefaultProjectId ?? config.defaultProjectId,
      defaultWorkspaceRoot: storedDefaultProjectId ? undefined : defaultWorkspaceRoot,
    });
    if (intakeResolution.status === 'blocked') {
      return reply.status(400).send({
        error: {
          message: intakeResolution.blocker ?? 'Project owner resolution blocked.',
          type: 'invalid_request_error',
          code: intakeResolution.reason,
        },
      });
    }
    const workspaceRoot = intakeResolution.workspaceRoot!;
    const projectId = intakeResolution.ownerRepo!;

    const ctx: ChatRunContext = { activeTaskRunId: undefined, activeRunSpecId: undefined, lastCheckpoint: null };

    // Shared runChat parameters (send/signal are injected per response mode).
    const chatParams: Omit<Parameters<typeof runChat>[0], 'send' | 'signal'> = {
      prompt,
      sessionId: sid,
      systemPrompt: systemPrompt || undefined,
      provider: body.model ?? config.agent.defaultProvider,
      model: body.model ? undefined : config.agent.defaultModel,
      providerFallback: undefined,
      modelSettings: undefined,
      workspaceRoot,
      // WeChat channel: keep risk low — L2 shell was flooding deny alerts.
      // Operator can still use CLI/Web with higher toolMode when needed.
      toolMode: 'read-only',
      allowedTools: undefined,
      manualSkillIds: undefined,
      maxLoops: Math.min(8, body.max_tokens ? Math.min(body.max_tokens, config.agent.maxLoops) : 8),
      timeoutMs: undefined,
      toolRetry: undefined,
      mcpServers: undefined,
      // Intentional: OpenAI-compat is high-volume / IDE traffic — never default-write memory.
      persistMemory: false,
      boundTodoId: undefined,
      branchFrom: undefined,
      branchAtTurn: undefined,
      traceId,
      dedupeKey: undefined,
      sid,
      tenantId: context.tenantId,
      projectId,
      userId: context.userId,
      actorSubject: principal.subject,
      requestId: context.requestId,
      runContract: undefined,
      intakeResolution,
      requestedProjectId,
      requestedWorkspaceRoot: undefined,
      config,
      gatewayServiceId,
      identityName: undefined,
      identityLevel: undefined,
      log: context.log,
      ctx,
    };

    if (wantStream) {
      await streamChatCompletion({
        reply,
        base,
        run: async ({ send, signal }) => {
          await dependencies.runChat({ ...chatParams, signal, send });
        },
      });
      return;
    }

    // ── Non-streaming JSON path ──
    let resultText = '';
    let finalStatus = 'failed';

    // Minimal send function — captures text only (no SSE to WeClaw)
    const send: SendEvent = (event, data) => {
      if (event === 'done' && typeof data === 'object' && data !== null) {
        const d = data as Record<string, unknown>;
        if (typeof d.text === 'string') resultText = d.text;
        finalStatus = 'completed';
      }
      if (event === 'cancelled' || event === 'blocked' || event === 'error') {
        finalStatus = event;
      }
    };

    try {
      await dependencies.runChat({ ...chatParams, send });

      return reply.send({
        id: completionId,
        object: 'chat.completion',
        created,
        model: responseModel,
        choices: [{
          index: 0,
          message: {
            role: 'assistant',
            content: resultText || '(no response)',
          },
          finish_reason: finalStatus === 'completed' ? 'stop' : finalStatus,
        }],
        usage: {
          prompt_tokens: prompt.length,
          completion_tokens: resultText.length,
          total_tokens: prompt.length + resultText.length,
        },
      });
    } catch (err: any) {
      return reply.status(500).send({
        error: {
          message: err?.message ?? 'Internal error',
          type: 'internal_error',
          ...structuredErrorFields(err),
        },
      });
    }
  });
}

// ── SSE (OpenAI chat.completion.chunk wire format) ──────────────

function sseHeaders(): Record<string, string> {
  return {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  };
}

function writeSSEChunk(reply: any, payload: Record<string, unknown>): void {
  reply.raw.write(`data: ${JSON.stringify(payload)}\n\n`);
}

/**
 * Stream a real runChat execution as OpenAI SSE.
 *
 * The gateway already relays per-token provider deltas through the
 * `model.delta` chat event (textDelta/reasoningDelta), so this is true
 * token-level streaming — not a post-hoc chunked JSON response. Terminal
 * events (`done` / `error` / `blocked`) close the stream with the standard
 * finish chunk + `data: [DONE]`; the client disconnecting aborts the agent
 * run via the runChat abort signal.
 */
async function streamChatCompletion(opts: {
  reply: any;
  base: { id: string; created: number; model: string };
  run: (input: { send: SendEvent; signal: AbortSignal }) => Promise<unknown>;
}): Promise<void> {
  const { reply, base, run } = opts;
  const chunkBase = { ...base, object: 'chat.completion.chunk' };

  // Headers must go out before the (possibly long) agent run so the client
  // sees the stream immediately.
  reply.raw.writeHead(200, sseHeaders());

  // Standard OpenAI stream opens with the assistant role chunk.
  writeSSEChunk(reply, { ...chunkBase, choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] });

  let emittedText = '';
  // Object property (not a bare let): the send closure reassigns it, and TS
  // keeps property types intact across closure boundaries.
  const state = {
    terminalStatus: 'failed' as 'completed' | 'cancelled' | 'blocked' | 'failed',
    terminalReason: undefined as string | undefined,
  };
  let ended = false;
  const endStream = () => {
    if (ended) return;
    ended = true;
    reply.raw.end();
  };
  const finishChunk = (finishReason: string, error?: unknown) => {
    const payload: Record<string, unknown> = {
      ...chunkBase,
      choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
    };
    if (error !== undefined) payload.error = error;
    writeSSEChunk(reply, payload);
  };

  const send: SendEvent = (event, data) => {
    if (event === 'model.delta' && data !== null && typeof data === 'object') {
      // Real per-token delta relayed from the provider stream.
      const d = data as Record<string, unknown>;
      const text = typeof d.textDelta === 'string' ? d.textDelta : '';
      const reasoning = typeof d.reasoningDelta === 'string' ? d.reasoningDelta : '';
      if (!text && !reasoning) return;
      emittedText += text;
      const delta: Record<string, unknown> = {};
      if (text) delta.content = text;
      // DeepSeek-style reasoning channel; unknown fields are ignored by
      // standard OpenAI clients.
      if (reasoning) delta.reasoning_content = reasoning;
      writeSSEChunk(reply, { ...chunkBase, choices: [{ index: 0, delta, finish_reason: null }] });
      return;
    }
    if (event === 'done') {
      state.terminalStatus = 'completed';
      const d = data !== null && typeof data === 'object' ? (data as Record<string, unknown>) : {};
      const fullText = typeof d.text === 'string' ? d.text : '';
      // Reconciliation: some providers emit deltas, some don't; `done.text` is
      // the authoritative full text. Emit only the missing tail so clients
      // that concatenate deltas always end up with the complete answer.
      if (fullText.startsWith(emittedText) && fullText.length > emittedText.length) {
        writeSSEChunk(reply, {
          ...chunkBase,
          choices: [{ index: 0, delta: { content: fullText.slice(emittedText.length) }, finish_reason: null }],
        });
        emittedText = fullText;
      }
      finishChunk('stop');
      const tokens = d.tokens;
      if (tokens !== null && typeof tokens === 'object') {
        const t = tokens as { prompt?: unknown; completion?: unknown };
        const promptTokens = Number(t.prompt ?? 0);
        const completionTokens = Number(t.completion ?? 0);
        writeSSEChunk(reply, {
          ...chunkBase,
          choices: [],
          usage: {
            prompt_tokens: promptTokens,
            completion_tokens: completionTokens,
            total_tokens: promptTokens + completionTokens,
          },
        });
      }
      reply.raw.write('data: [DONE]\n\n');
      endStream();
      return;
    }
    if (event === 'cancelled' || event === 'blocked') {
      // Terminal outcome marker; 'cancelled' is followed by 'done', 'blocked'
      // is terminal by itself (closed by the defensive tail below).
      state.terminalStatus = event;
      const d = data !== null && typeof data === 'object' ? (data as Record<string, unknown>) : {};
      if (typeof d.reason === 'string' && d.reason.length > 0) state.terminalReason = d.reason;
      return;
    }
    if (event === 'error') {
      state.terminalStatus = 'failed';
      const d = data !== null && typeof data === 'object' ? (data as Record<string, unknown>) : {};
      const message = typeof d.message === 'string' ? d.message : String(data);
      // Keep the machine-readable failure classification (AgentError
      // code/httpStatus/retryable/…) on the wire: the stream already answered
      // HTTP 200 (headers went out before the agent run), so clients can only
      // classify this terminal chunk — text-matching alone is not enough for
      // retry decisions on upstream 429/5xx wrapped as finish_reason "error".
      finishChunk('error', { message, ...structuredErrorFields(d) });
      reply.raw.write('data: [DONE]\n\n');
      endStream();
      return;
    }
    // All other events (turn/task/session/operator/tool.call.upsert/… and the
    // relayed session-event ledger) are internal observability and are NOT
    // part of the OpenAI wire format.
  };

  // Abort the agent run when the SSE client goes away mid-stream.
  const abortController = new AbortController();
  reply.raw.on('close', () => {
    if (!reply.raw.writableEnded) abortController.abort();
  });

  try {
    await run({ send, signal: abortController.signal });
  } catch (err: any) {
    send('error', { message: err?.message ?? String(err), ...structuredErrorFields(err) });
  }

  // Defensive: every runChat outcome ends with done/error/blocked; if none
  // arrived for any reason, close the stream so the client never hangs.
  if (!ended) {
    const terminalError = state.terminalStatus === 'completed'
      ? undefined
      : state.terminalReason !== undefined
        ? { message: state.terminalReason }
        : undefined;
    finishChunk(state.terminalStatus === 'completed' ? 'stop' : state.terminalStatus, terminalError);
    reply.raw.write('data: [DONE]\n\n');
    endStream();
  }
}

/**
 * Pick the machine-readable failure fields an AgentError (error-base.ts
 * `toJSON`) carries onto error payloads, so OpenAI-compatible clients get the
 * HTTP status / retryable classification without text-matching the message.
 * Accepts either the error object itself or its already-serialized `toJSON()`
 * output; plain Errors contribute nothing.
 */
function structuredErrorFields(error: unknown): Record<string, unknown> {
  const source: Record<string, unknown> = typeof error === 'object' && error !== null
    ? (error as Record<string, unknown>)
    : {};
  const serialized = typeof (error as { toJSON?: unknown })?.toJSON === 'function'
    ? (error as { toJSON: () => Record<string, unknown> }).toJSON()
    : undefined;
  const out: Record<string, unknown> = {};
  for (const key of ['code', 'httpStatus', 'retryable', 'provider', 'model', 'rateLimitResetMs'] as const) {
    const value = serialized?.[key] ?? source[key];
    if (value !== undefined) out[key] = value;
  }
  return out;
}

function normalizeHeader(value: string | string[] | undefined): string | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  return trimmed || undefined;
}
