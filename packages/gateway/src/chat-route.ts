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
import { getDefaultProjectId, resolveConfiguredProjectOwner } from './project-store.js';
import { persistChatIntakeEvent } from './chat-intake-events.js';
import {
  completeIdempotencyKey,
  reserveIdempotentRequest,
} from './idempotency.js';
import { startIdempotencyLeaseHeartbeat } from './idempotency-execution.js';
import { getMessagePrincipal, getRequestContext } from './request-context.js';
import type { ChatRequestBody } from './chat-route-types.js';
import { runChat, type ChatRunContext, type SendEvent } from './chat-service.js';
import type { MessageRouter } from '@los/agent/message-router';
import { validateRunSpecRequest } from '@los/contracts/run-spec';
import {
  normalizeProviderFallbackPolicy,
  resolveProviderFallbackInitialTarget,
  validateProviderModelRequest,
  type ProviderFallbackPolicy,
} from '@los/agent';

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
    const contractValidation = validateRunSpecRequest(req.body);
    if (!contractValidation.success) {
      return reply.status(400).send({
        error: 'invalid_run_spec_request',
        issues: contractValidation.errors.map(error => ({
          path: error.instancePath || '/',
          message: error.message ?? 'is invalid',
        })),
      });
    }
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
    const providerModelValidation = validateProviderModelRequest({
      provider,
      model,
      defaultProvider: config.agent.defaultProvider,
      defaultModel: config.agent.defaultModel,
      configuredProviders: config.providers,
    });
    if (!providerModelValidation.valid && (!body.providerFallback || provider || model)) {
      return reply.status(400).send({
        error: 'invalid_provider_model',
        code: providerModelValidation.code,
        message: providerModelValidation.message,
      });
    }
    let providerFallback: ProviderFallbackPolicy | undefined;
    try {
      providerFallback = normalizeProviderFallbackPolicy(body.providerFallback);
      resolveProviderFallbackInitialTarget(providerFallback, { provider, model });
    } catch (error) {
      return reply.status(400).send({
        error: 'invalid_provider_fallback',
        code: 'fallback_policy_invalid',
        message: error instanceof Error ? error.message : String(error),
      });
    }
    if (providerFallback) {
      for (const target of providerFallback.targets) {
        if (providerFallback.requireCompatibilityEvidence && !target.model) {
          return reply.status(400).send({
            error: 'invalid_provider_fallback',
            code: 'fallback_model_required',
            message: `provider fallback target '${target.provider}' must name a model when compatibility evidence is required`,
          });
        }
        const targetValidation = validateProviderModelRequest({
          provider: target.provider,
          model: target.model,
          defaultProvider: config.agent.defaultProvider,
          defaultModel: config.agent.defaultModel,
          configuredProviders: config.providers,
        });
        if (!targetValidation.valid) {
          return reply.status(400).send({
            error: 'invalid_provider_fallback',
            code: targetValidation.code,
            message: targetValidation.message,
          });
        }
      }
    }
    const modelSettings = normalizeModelSettings(body.modelSettings);
    const headerProjectId = normalizeOptionalString(Array.isArray(req.headers['x-project-id'])
      ? req.headers['x-project-id'][0]
      : req.headers['x-project-id']);
    const bodyProjectId = normalizeOptionalString(body.projectId);
    const requestedProjectId = bodyProjectId ?? headerProjectId;
    const requestedWorkspace = normalizeOptionalString(body.workspaceRoot);
    const requestedWorkspaceRoot = requestedWorkspace
      ? normalizeWorkspaceRoot(requestedWorkspace, defaultWorkspaceRoot)
      : undefined;
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

    const sid = branchFrom
      ? `session-${Date.now()}`
      : (sessionId ?? `session-${Date.now()}`);
    const storedDefaultProjectId = getDefaultProjectId();
    const intakeResolution = resolveConfiguredProjectOwner({
      requestedProjectId: bodyProjectId,
      contextProjectId: headerProjectId,
      workspaceRoot: requestedWorkspaceRoot,
      defaultProjectId: storedDefaultProjectId ?? config.defaultProjectId,
      defaultWorkspaceRoot: storedDefaultProjectId ? undefined : defaultWorkspaceRoot,
    });
    if (intakeResolution.status === 'blocked') {
      await persistChatIntakeEvent({
        sessionId: sid,
        tenantId: context.tenantId,
        userId: context.userId,
        requestId: context.requestId,
        traceId,
        requestedProjectId,
        requestedWorkspaceRoot,
        resolution: intakeResolution,
      });
      const statusCode = intakeResolution.reason === 'project_context_conflict'
        || intakeResolution.reason === 'project_workspace_conflict'
        || intakeResolution.reason === 'ambiguous_workspace' ? 409 : 400;
      return reply.status(statusCode).send({
        error: 'project owner resolution blocked',
        reason: intakeResolution.reason,
        blocker: intakeResolution.blocker,
        sessionId: sid,
        requestId: context.requestId,
      });
    }
    const workspaceRoot = intakeResolution.workspaceRoot!;
    const projectId = intakeResolution.ownerRepo!;

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
    const activeIdempotency = idempotency?.status === 'reserved' || idempotency?.status === 'reclaimed'
      ? idempotency
      : null;
    const idempotencyAbort = new AbortController();
    const idempotencyHeartbeat = activeIdempotency
      ? startIdempotencyLeaseHeartbeat(activeIdempotency, {
          onLeaseLost: error => idempotencyAbort.abort(error),
        })
      : null;

    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
      ...(activeIdempotency ? {
        'X-Idempotency-Key': activeIdempotency.idempotencyKey,
        'X-Idempotency-Status': activeIdempotency.status,
      } : {}),
    });

    const replayEvents: Array<{ event: string; data: unknown }> = [];
    const cappedReplay = () => replayEvents.slice(-500);
    const send: SendEvent = (event, data, id?) => {
      replayEvents.push({ event, data });
      if (id !== undefined) reply.raw.write(`id: ${id}\n`);
      reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    const ctx: ChatRunContext = { activeTaskRunId: undefined, activeRunSpecId: undefined, lastCheckpoint: null };

    try {
      const result = await runChat({
        prompt, sessionId, systemPrompt, provider, model, providerFallback,
        modelSettings: modelSettings as Record<string, unknown> | undefined,
        workspaceRoot, toolMode, sandboxMode, allowedTools, maxLoops, timeoutMs,
        toolRetry: toolRetry as Record<string, unknown> | undefined,
        mcpServers, persistMemory, boundTodoId, branchFrom, branchAtTurn,
        identityName, identityLevel,
        traceId, dedupeKey, sid,
        signal: idempotencyAbort.signal,
        tenantId: context.tenantId,
        projectId,
        userId: context.userId, requestId: context.requestId,
        actorSubject: principal.subject,
        runContract: body.runContract,
        intakeResolution,
        requestedProjectId,
        requestedWorkspaceRoot,
        config, gatewayServiceId, log: context.log, ctx, send,
      });

      // Idempotency completion: all paths
      if (activeIdempotency) {
        await idempotencyHeartbeat?.stop();
        await completeIdempotencyKey(activeIdempotency.id, 200, { events: cappedReplay() }, activeIdempotency.ownerId);
      }
    } catch (err: any) {
      await idempotencyHeartbeat?.stop();
      await persistChatError({
        err,
        sessionId: sid,
        taskRunId: ctx.activeTaskRunId ?? null,
        traceId,
        requestId: context.requestId,
        tenantId: context.tenantId,
        projectId,
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
        idempotency: activeIdempotency
          ? { id: activeIdempotency.id, ownerId: activeIdempotency.ownerId }
          : null,
      });
      send('error', { message: err?.message ?? String(err) });
    }

    reply.raw.end();
  });
}
