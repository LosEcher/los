import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { Config } from '@los/infra/config';
import { normalizeModelSettings } from '@los/agent/model-settings';
import {
  normalizeWorkspaceRoot,
  normalizeOptionalString,
  normalizeToolMode,
  normalizeSandboxMode,
  normalizeAllowedTools,
  normalizePositiveInteger,
  normalizeToolRetry,
  normalizeMCPServers,
} from './chat-normalizers.js';
import { normalizeReplayEvents } from './chat-session-helpers.js';
import { persistChatError } from './chat-route-persist.js';
import { resolveProjectIdFromWorkspace } from './project-store.js';
import {
  completeIdempotencyKey,
  reserveIdempotentRequest,
} from './idempotency.js';
import { getMessagePrincipal, getRequestContext } from './request-context.js';
import type { ChatRequestBody } from './chat-route-types.js';
import { runChat, type ChatRunContext, type SendEvent } from './chat-service.js';
import type { MessageRouter } from '@los/agent/message-router';

const CHAT_BODY_LIMIT_BYTES = 1024 * 1024;

export function registerChatRoute(
  app: FastifyInstance,
  config: Config,
  defaultWorkspaceRoot: string,
  gatewayServiceId?: string,
  rateLimitHook?: (req: FastifyRequest, reply: FastifyReply) => Promise<void>,
  messageRouter?: MessageRouter,
): void {
  app.post('/chat', { bodyLimit: CHAT_BODY_LIMIT_BYTES }, async (req, reply) => {
    if (rateLimitHook) await rateLimitHook(req, reply);
    if (reply.sent) return;
    const body = req.body as ChatRequestBody;
    const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';

    // ── MessageRouter pre-check: if text starts with #, check for commands ──
    if (messageRouter && prompt.startsWith('#')) {
      const intent = messageRouter.resolveIntent(prompt);
      if (intent.type !== 'chat' && intent.type !== 'unknown') {
        // Command detected — dispatch via router (non-streaming)
        const result = await messageRouter.route({
          sourceKind: 'http-chat',
          prompt,
          sessionId: body.sessionId,
        }, { principal: getMessagePrincipal(req) });
        if (result.error === 'operator_required') {
          return reply.status(403).send({
            error: 'operator_required',
            message: result.text ?? 'Operator authorization required for this command.',
            intent: result.intent.type,
          });
        }
        if (result.handled) {
          return reply.send({ ok: true, text: result.text, sessionId: result.sessionId, intent: result.intent.type });
        }
        return reply.status(400).send({ error: result.error ?? 'Command not handled', intent: result.intent.type });
      }
      // # prefix but not a recognized command → fall through to normal chat
    }
    const sessionId = normalizeOptionalString(body.sessionId);
    const systemPrompt = normalizeOptionalString(body.systemPrompt);
    const provider = normalizeOptionalString(body.provider);
    const model = normalizeOptionalString(body.model);
    const modelSettings = normalizeModelSettings(body.modelSettings);
    const workspaceRoot = normalizeWorkspaceRoot(body.workspaceRoot, defaultWorkspaceRoot);
    const toolMode = normalizeToolMode(body.toolMode);
    const allowedTools = normalizeAllowedTools(body.allowedTools);
    const maxLoops = normalizePositiveInteger(body.maxLoops);
    const context = getRequestContext(req);
    const principal = getMessagePrincipal(req);
    const traceId = normalizeOptionalString(body.traceId) ?? context.traceId;
    const dedupeKey = normalizeOptionalString(body.dedupeKey);
    const timeoutMs = normalizePositiveInteger(body.timeoutMs);
    const toolRetry = normalizeToolRetry(body.toolRetry);
    const mcpServers = normalizeMCPServers(body.mcpServers);
    // Explicit body wins; otherwise use config default (true → episodic observations after chat).
    const persistMemory = typeof body.persistMemory === 'boolean'
      ? body.persistMemory
      : config.memory.persistChatDefault !== false;
    const boundTodoId = normalizeOptionalString(body.todoId);
    const branchFrom = normalizeOptionalString(body.branchFrom);
    const branchAtTurn = typeof body.branchAtTurn === 'number' && body.branchAtTurn > 0
      ? Math.floor(body.branchAtTurn)
      : undefined;
    const identityName = normalizeOptionalString(body.identityName);
    const identityLevel = normalizeOptionalString(body.identityLevel);
    const sandboxMode = normalizeSandboxMode(body.sandboxMode);

    if (!prompt) {
      return reply.status(400).send({ error: 'prompt is required' });
    }

    const idempotency = await reserveIdempotentRequest(req, {
      route: '/chat',
      method: 'POST',
      body,
      context,
    });
    if (idempotency?.status === 'body_mismatch') {
      return reply.status(409).send({
        error: 'idempotency key body mismatch',
        requestId: context.requestId,
        idempotencyKey: idempotency.idempotencyKey,
      });
    }
    if (idempotency?.status === 'processing') {
      return reply.status(409).send({
        error: 'idempotency key is already processing',
        requestId: context.requestId,
        idempotencyKey: idempotency.idempotencyKey,
      });
    }
    if (idempotency?.status === 'replayed') {
      reply.raw.writeHead(idempotency.responseStatus ?? 200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
        'X-Idempotency-Key': idempotency.idempotencyKey,
        'X-Idempotency-Status': 'replayed',
      });
      for (const event of normalizeReplayEvents(idempotency.responseJson)) {
        reply.raw.write(`event: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`);
      }
      reply.raw.end();
      return;
    }

    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
      ...(idempotency ? {
        'X-Idempotency-Key': idempotency.idempotencyKey,
        'X-Idempotency-Status': idempotency.status,
      } : {}),
    });

    const replayEvents: Array<{ event: string; data: unknown }> = [];
    const cappedReplay = () => replayEvents.slice(-500);
    const send: SendEvent = (event, data, id?) => {
      replayEvents.push({ event, data });
      if (id !== undefined) reply.raw.write(`id: ${id}\n`);
      reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    const sid = branchFrom
      ? `session-${Date.now()}`
      : (sessionId ?? `session-${Date.now()}`);
    const ctx: ChatRunContext = { activeTaskRunId: undefined, activeRunSpecId: undefined, lastCheckpoint: null };

    try {
      const result = await runChat({
        prompt, sessionId, systemPrompt, provider, model,
        modelSettings: modelSettings as Record<string, unknown> | undefined,
        workspaceRoot, toolMode, sandboxMode, allowedTools, maxLoops, timeoutMs,
        toolRetry: toolRetry as Record<string, unknown> | undefined,
        mcpServers, persistMemory, boundTodoId, branchFrom, branchAtTurn,
        identityName, identityLevel,
        traceId, dedupeKey, sid,
        tenantId: context.tenantId,
        projectId: resolveProjectIdFromWorkspace(workspaceRoot) ?? context.projectId,
        userId: context.userId, requestId: context.requestId,
        actorSubject: principal.subject,
        runContract: body.runContract,
        config, gatewayServiceId, log: context.log, ctx, send,
      });

      // Idempotency completion: all paths
      if (idempotency) {
        await completeIdempotencyKey(idempotency.id, 200, { events: cappedReplay() });
      }
    } catch (err: any) {
      await persistChatError({
        err,
        sessionId: sid,
        taskRunId: ctx.activeTaskRunId ?? null,
        traceId,
        requestId: context.requestId,
        tenantId: context.tenantId,
        projectId: context.projectId,
        userId: context.userId,
        activeRunSpecId: ctx.activeRunSpecId ?? null,
        boundTodoId: boundTodoId ?? null,
        lastCheckpoint: ctx.lastCheckpoint,
        resumedSession: null,
        provider: provider ?? config.agent.defaultProvider,
        model: model ?? null,
        workspaceRoot,
        toolMode,
        runSpecId: ctx.activeRunSpecId ?? `run-${sid}-${Date.now()}`,
        idempotency: idempotency ? { id: idempotency.id } : null,
      });
      send('error', { message: err?.message ?? String(err) });
    }

    reply.raw.end();
  });
}
