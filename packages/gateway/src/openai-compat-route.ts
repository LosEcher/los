/**
 * OpenAI-compatible /v1/chat/completions endpoint.
 *
 * Translates OpenAI chat completions format into los chat format,
 * calls the los agent loop, and returns a plain JSON response
 * (no SSE streaming needed for WeClaw HTTP agent integration).
 *
 * This enables WeClaw to use los as an HTTP agent:
 *   WeChat → WeClaw → HTTP POST /v1/chat/completions → los agent loop → Tool Gate + OTel
 */

import type { FastifyInstance } from 'fastify';
import type { MessageRouter } from '@los/agent/message-router';
import { runChat, type ChatRunContext, type SendEvent } from './chat-service.js';
import { getMessagePrincipal, getRequestContext } from './request-context.js';

interface OpenAIChatRequest {
  model?: string;
  messages: Array<{ role: string; content: string }>;
  stream?: boolean;
  max_tokens?: number;
  temperature?: number;
}

export function registerOpenAICompatibleRoute(
  app: FastifyInstance,
  config: ReturnType<typeof import('@los/infra/config').getConfig>,
  defaultWorkspaceRoot: string,
  gatewayServiceId?: string,
  messageRouter?: MessageRouter,
): void {
  app.post('/v1/chat/completions', async (req: any, reply: any) => {
    const body = req.body as OpenAIChatRequest;
    const context = getRequestContext(req);
    const sid = `chat-${body.model ?? 'openai'}-${Date.now()}`;
    const traceId = `trace-${context.requestId}`;

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
        }, { principal: getMessagePrincipal(req) });
        const text = result.handled
          ? (result.text ?? 'ok')
          : (result.error ?? '命令未处理');
        return reply.send({
          id: `chatcmpl-${context.requestId}`,
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model: body.model ?? 'los',
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
    }

    const ctx: ChatRunContext = { activeTaskRunId: undefined, activeRunSpecId: undefined, lastCheckpoint: null };
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
      await (runChat as any)({
        prompt,
        sessionId: sid,
        systemPrompt: systemPrompt || undefined,
        provider: body.model ?? config.agent.defaultProvider,
        model: body.model ? undefined : config.agent.defaultModel,
        modelSettings: undefined,
        workspaceRoot: defaultWorkspaceRoot,
        // WeChat channel: keep risk low — L2 shell was flooding deny alerts.
        // Operator can still use CLI/Web with higher toolMode when needed.
        toolMode: 'read-only',
        allowedTools: undefined,
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
        projectId: context.projectId,
        userId: context.userId,
        requestId: context.requestId,
        runContract: undefined,
        config,
        gatewayServiceId,
        log: context.log,
        ctx,
        send,
      });

      return reply.send({
        id: `chatcmpl-${context.requestId}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: body.model ?? 'los',
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
        },
      });
    }
  });
}
