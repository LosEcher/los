import { isAllowedChat, isAllowedUser } from './ingress-security.js';
import type { TelegramActionRegistry, TelegramOperatorAction } from './action-registry.js';

export interface TelegramUser {
  id: number;
}

export interface TelegramMessage {
  message_id: number;
  chat: { id: number };
  from?: TelegramUser;
  text?: string;
}

export interface TelegramCallbackQuery {
  id: string;
  from: TelegramUser;
  message?: TelegramMessage;
  data: string;
}

export interface TelegramUpdate {
  update_id?: number;
  message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
}

interface OperatorActionHandlerOptions {
  gatewayUrl: string;
  allowedChatIds: ReadonlySet<number>;
  allowedUserIds: ReadonlySet<number>;
  actionRegistry: TelegramActionRegistry;
  makeHeaders: (extra?: Record<string, string>) => Record<string, string>;
  answerCallback: (callbackId: string, text?: string) => Promise<void>;
  fetchImpl?: typeof fetch;
  warn?: (message: string) => void;
}

export function createOperatorActionHandler(options: OperatorActionHandlerOptions) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const warn = options.warn ?? console.warn;

  async function postSteering(
    sessionId: string,
    instruction: string,
    reason: string,
    successMessage: string,
    idempotencyKey: string,
    userId: number,
  ): Promise<{ ok: boolean; text: string }> {
    const response = await fetchImpl(
      `${options.gatewayUrl}/sessions/${encodeURIComponent(sessionId)}/operator-events`,
      {
        method: 'POST',
        headers: options.makeHeaders({
          'Content-Type': 'application/json',
          'x-idempotency-key': idempotencyKey,
          'x-user-id': `telegram:${userId}`,
        }),
        body: JSON.stringify({
          type: 'steering',
          instruction,
          turnBoundary: 'immediate',
          reason,
        }),
      },
    );
    return {
      ok: response.ok,
      text: response.ok ? successMessage : `Telegram action failed: ${response.status}`,
    };
  }

  async function handleAction(
    action: TelegramOperatorAction,
    sessionId: string,
    callId: string,
    idempotencyKey: string,
    userId: number,
  ): Promise<{ ok: boolean; text: string }> {
    const callSuffix = callId ? `: callId=${callId}` : '';
    switch (action) {
      case 'approve':
        return postSteering(sessionId, `Approved via Telegram${callSuffix}`, 'operator_approval', '✅ Approved', idempotencyKey, userId);
      case 'deny':
        return postSteering(sessionId, `Denied via Telegram${callSuffix}`, 'operator_denial', '❌ Denied', idempotencyKey, userId);
      case 'escalate':
        return postSteering(
          sessionId,
          `Escalated from Telegram: session=${sessionId} callId=${callId}`,
          'operator_escalation',
          '↗ Escalated to operator queue',
          idempotencyKey,
          userId,
        );
    }
  }

  return async function handleCallback(callbackQuery: TelegramCallbackQuery): Promise<void> {
    const chatId = callbackQuery.message?.chat?.id;
    const userId = callbackQuery.from?.id;
    if (!isAllowedChat(chatId, options.allowedChatIds) || !isAllowedUser(userId, options.allowedUserIds)) {
      warn(`Rejected Telegram callback from unauthorized chat/user: ${String(chatId)}/${String(userId)}`);
      await options.answerCallback(callbackQuery.id, 'Unauthorized operator');
      return;
    }

    const claim = await options.actionRegistry.claim(callbackQuery.data, callbackQuery.id);
    if (claim.status !== 'claimed') {
      const message = claim.status === 'invalid' ? 'Expired or invalid action'
        : claim.status === 'consumed' ? 'Action already handled'
        : 'Action already processing';
      await options.answerCallback(callbackQuery.id, message);
      return;
    }

    try {
      const result = await handleAction(
        claim.target.action,
        claim.target.sessionId,
        claim.target.callId,
        options.actionRegistry.idempotencyKey(claim.decisionGroupId),
        userId,
      );
      if (result.ok) {
        await options.actionRegistry.consume(callbackQuery.data, callbackQuery.id, callbackQuery.id, userId);
      } else {
        await options.actionRegistry.release(callbackQuery.data, callbackQuery.id);
      }
      await options.answerCallback(callbackQuery.id, result.text);
    } catch (error) {
      await options.actionRegistry.release(callbackQuery.data, callbackQuery.id).catch(() => undefined);
      throw error;
    }
  };
}
