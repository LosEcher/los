/**
 * @los/telegram-bot — IM handoff bot for agent task approval.
 *
 * Subscribes to los SSE event stream (PG NOTIFY + eventBus relay) and
 * sends Telegram messages when operator attention is needed. The operator
 * can approve/deny/escalate via inline buttons.
 *
 * Architecture:
 *   los gateway SSE → Telegram Bot (this process)
 *       → operator_attention event detected
 *       → send Telegram message with [Approve] [Deny] [Escalate] buttons
 *   operator clicks button
 *       → Telegram callback → HTTP POST /operator/steering
 *       → los records operator.steering event → agent acts on it
 *
 * Standalone process: node packages/telegram-bot/src/index.js
 *
 * Requires:
 *   TELEGRAM_BOT_TOKEN — from @BotFather
 *   TELEGRAM_ALLOWED_CHAT_IDS — comma-separated pre-authorized chat IDs
 *   TELEGRAM_ALLOWED_USER_IDS — comma-separated pre-authorized operator user IDs
 *   LOS_GATEWAY_URL     — los gateway base URL (default http://localhost:8080)
 *
 * Usage:
 *   TELEGRAM_BOT_TOKEN=xxx TELEGRAM_ALLOWED_CHAT_IDS=123 TELEGRAM_ALLOWED_USER_IDS=456 pnpm dev
 */

import { createServer } from 'node:http';
import {
  parseAllowedChatIds,
  parseAllowedUserIds,
  validateWebhookSecret,
  validateWebhookUrl,
} from './ingress-security.js';
import { createOperatorActionHandler, type TelegramUpdate } from './operator-actions.js';
import { TelegramActionRegistry } from './action-registry.js';
import { createTelegramUpdateProcessor, prepareTelegramPolling, runTelegramPollingLoop } from './telegram-updates.js';
import { createTelegramWebhookHandler, startTelegramWebhook } from './telegram-webhook.js';
import { ensureTelegramActionStore } from './telegram-action-store.js';
import { startTelegramHealthServer } from './health-server.js';
import { loadConfig } from '@los/infra/config';
import { initDb } from '@los/infra/db';

// ── Config ─────────────────────────────────────────────────────────

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!BOT_TOKEN) {
  console.error('FATAL: TELEGRAM_BOT_TOKEN is required. Get one from @BotFather.');
  process.exit(1);
}

const LOS_GATEWAY_URL = process.env.LOS_GATEWAY_URL ?? 'http://localhost:8080';
const LOS_AUTH_TOKEN = process.env.LOS_AUTH_TOKEN;
const LOS_OPERATOR_TOKEN = process.env.LOS_OPERATOR_TOKEN;
const WEBHOOK_PORT = Number(process.env.TELEGRAM_WEBHOOK_PORT ?? 0);
const POLL_INTERVAL_MS = Number(process.env.TELEGRAM_POLL_INTERVAL ?? 5000);
const SSE_RECONNECT_MS = Number(process.env.SSE_RECONNECT_MS ?? 3000);
const HEALTH_PORT = Number(process.env.TELEGRAM_HEALTH_PORT ?? 3002);
const WEBHOOK_BIND_HOST = '127.0.0.1';

const configuredChatIds = process.env.TELEGRAM_ALLOWED_CHAT_IDS ?? process.env.TELEGRAM_CHAT_ID;
const authorizedChats = parseAllowedChatIds(configuredChatIds);
if (authorizedChats.size === 0) {
  console.error('FATAL: TELEGRAM_ALLOWED_CHAT_IDS must contain at least one pre-authorized chat ID.');
  process.exit(1);
}
const authorizedUsers = parseAllowedUserIds(process.env.TELEGRAM_ALLOWED_USER_IDS);
if (authorizedUsers.size === 0) {
  console.error('FATAL: TELEGRAM_ALLOWED_USER_IDS must contain at least one pre-authorized operator user ID.');
  process.exit(1);
}

const WEBHOOK_SECRET = WEBHOOK_PORT > 0
  ? validateWebhookSecret(process.env.TELEGRAM_WEBHOOK_SECRET)
  : undefined;
const WEBHOOK_URL = WEBHOOK_PORT > 0
  ? validateWebhookUrl(process.env.TELEGRAM_WEBHOOK_URL)
  : undefined;

function losHeaders(extra: Record<string, string> = {}): Record<string, string> {
  let h = extra;
  if (LOS_AUTH_TOKEN) h = { ...h, 'x-los-auth-token': LOS_AUTH_TOKEN };
  // Operator token is required by /sessions/:id/operator-events (steering /
  // approve-deny-escalate) when the gateway has auth enabled. Send it when
  // configured so the bot's operator actions pass the consent gate.
  if (LOS_OPERATOR_TOKEN) h = { ...h, 'x-los-operator-token': LOS_OPERATOR_TOKEN };
  return h;
}

// ── Telegram API helpers ───────────────────────────────────────────

const TG_API = `https://api.telegram.org/bot${BOT_TOKEN}`;

async function tgApi(method: string, body: Record<string, unknown> = {}): Promise<unknown> {
  const res = await fetch(`${TG_API}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    console.error(`Telegram API error: ${res.status} ${await res.text()}`);
    return null;
  }
  return res.json();
}

async function sendMessage(chatId: number | string, text: string, buttons?: Array<Array<{ text: string; callback_data: string }>>): Promise<number | null> {
  const body: Record<string, unknown> = {
    chat_id: chatId,
    text,
    parse_mode: 'Markdown',
  };
  if (buttons) {
    body.reply_markup = { inline_keyboard: buttons };
  }
  const result = await tgApi('sendMessage', body);
  return (result as any)?.result?.message_id ?? null;
}

async function answerCallback(callbackId: string, text?: string): Promise<void> {
  await tgApi('answerCallbackQuery', { callback_query_id: callbackId, text });
}

const actionRegistry = new TelegramActionRegistry();
const handleCallback = createOperatorActionHandler({
  gatewayUrl: LOS_GATEWAY_URL,
  allowedChatIds: authorizedChats,
  allowedUserIds: authorizedUsers,
  actionRegistry,
  makeHeaders: losHeaders,
  answerCallback,
});
const processUpdate = createTelegramUpdateProcessor({ handleCallback });

// ── Event → Message formatting ─────────────────────────────────────

interface OperatorAttentionEvent {
  sessionId: string;
  type: string;
  payload: {
    callId?: string;
    toolName?: string;
    args?: Record<string, unknown>;
    warnings?: string[];
    knownFailure?: boolean;
    flaggedFiles?: string[];
    reason?: string;
  };
}

function formatAlert(event: OperatorAttentionEvent): string {
  const tool = event.payload.toolName ?? 'unknown';
  const severity = event.payload.knownFailure ? '🔴' : '⚠️';
  const reason = event.payload.reason ? `\n> ${event.payload.reason}` : '';

  let text = `${severity} *Agent needs decision*\n`;
  text += `Tool: \`${tool}\`${reason}\n`;

  if (event.payload.warnings?.length) {
    for (const w of event.payload.warnings.slice(0, 3)) {
      text += `⚠ ${w}\n`;
    }
  }

  if (event.payload.flaggedFiles?.length) {
    text += `Files: ${event.payload.flaggedFiles.slice(0, 5).join(', ')}\n`;
  }

  text += `\nSession: \`${event.sessionId.slice(0, 8)}...\``;
  return text;
}

// ── SSE event consumer ─────────────────────────────────────────────

let sseAbort: AbortController | null = null;
let sseConnected = false;

async function connectSSE(): Promise<void> {
  if (sseAbort) sseAbort.abort();
  sseAbort = new AbortController();
  sseConnected = false;

  try {
    const url = `${LOS_GATEWAY_URL}/operator/events/live`;
    console.log(`Connecting to SSE: ${url}`);

    const res = await fetch(url, {
      headers: losHeaders({ 'Accept': 'text/event-stream' }),
      signal: sseAbort.signal,
    });

    if (!res.ok || !res.body) {
      console.error(`SSE connection failed: ${res.status}`);
      setTimeout(connectSSE, SSE_RECONNECT_MS);
      return;
    }
    sseConnected = true;

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let currentEvent = '';
    let currentData = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        if (line.startsWith('event: ')) {
          currentEvent = line.slice(7).trim();
        } else if (line.startsWith('data: ')) {
          currentData = line.slice(6).trim();
        } else if (line === '' && currentData) {
          // Complete event
          await handleSSEEvent(currentEvent, currentData);
          currentEvent = '';
          currentData = '';
        }
      }
    }
  } catch (err: any) {
    if (err.name === 'AbortError') return;
    console.error(`SSE error: ${err.message}`);
  }
  sseConnected = false;

  // Reconnect on disconnect
  setTimeout(connectSSE, SSE_RECONNECT_MS);
}

async function handleSSEEvent(eventType: string, data: string): Promise<void> {
  try {
    const parsed = JSON.parse(data);

    // Only handle operator_attention events
    if (eventType !== 'session.event') return;

    const payload = parsed.payload ?? {};
    const isOperatorAttention =
      parsed.type === 'tool.warned' ||
      parsed.type === 'tool.denied' ||
      parsed.type === 'operator_attention' ||
      (parsed.type === 'execution:transition' && payload.to === 'operator_attention') ||
      (parsed.type === 'session.blocked');

    if (!isOperatorAttention) return;

    const sessionId = parsed.sessionId ?? '';
    const alert: OperatorAttentionEvent = {
      sessionId,
      type: parsed.type,
      payload: {
        toolName: parsed.toolName ?? payload.tool_name,
        args: payload.args ?? payload.input,
        warnings: payload.warnings,
        knownFailure: payload.knownFailure,
        flaggedFiles: payload.flaggedFiles,
        reason: payload.reason ?? payload.error,
        callId: payload.callId ?? payload.call_id,
      },
    };

    const decisionGroupId = actionRegistry.createDecisionGroupId();
    for (const chatId of authorizedChats) {
      await sendMessage(
        chatId,
        formatAlert(alert),
        await actionRegistry.createButtons(sessionId, alert.payload.callId ?? '', decisionGroupId),
      );
    }
  } catch {
    // Parse error — skip
  }
}

// ── Main ───────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const config = await loadConfig();
  await initDb(config.databaseUrl);
  await ensureTelegramActionStore();
  console.log(`🤖 los Telegram Bot starting`);
  console.log(`   Gateway: ${LOS_GATEWAY_URL}`);
  console.log(`   Chats: ${[...authorizedChats].join(', ')}`);
  await startTelegramHealthServer({
    port: HEALTH_PORT,
    getSnapshot: () => ({ ready: sseConnected, sseConnected, mode: WEBHOOK_PORT > 0 ? 'webhook' : 'polling' }),
  });
  console.log(`   Health: http://127.0.0.1:${HEALTH_PORT}/health`);

  if (WEBHOOK_PORT > 0) {
    const server = createServer(createTelegramWebhookHandler({ secret: WEBHOOK_SECRET!, processUpdate }));
    await startTelegramWebhook({
      server,
      port: WEBHOOK_PORT,
      host: WEBHOOK_BIND_HOST,
      webhookUrl: WEBHOOK_URL!,
      secret: WEBHOOK_SECRET!,
      setWebhook: body => tgApi('setWebhook', body),
    });
    console.log(`Webhook listening on http://${WEBHOOK_BIND_HOST}:${WEBHOOK_PORT}`);
  } else {
    // Polling mode: check for updates periodically
    console.log('Polling mode (no webhook port configured)');
    await prepareTelegramPolling(options => tgApi('deleteWebhook', options));

    const pollingAbort = new AbortController();
    void runTelegramPollingLoop({
      signal: pollingAbort.signal,
      intervalMs: POLL_INTERVAL_MS,
      getUpdates: async offset => {
        const result = await tgApi('getUpdates', { offset, timeout: 5 });
        return (result as { result?: TelegramUpdate[] } | null)?.result ?? [];
      },
      processUpdate,
      onError: error => console.error(`Telegram polling error: ${error instanceof Error ? error.message : String(error)}`),
    });
    process.once('SIGINT', () => pollingAbort.abort());
    process.once('SIGTERM', () => pollingAbort.abort());
  }

  // Connect SSE event stream
  connectSSE();

  // Keep running
  process.on('SIGINT', () => { sseAbort?.abort(); process.exit(0); });
  process.on('SIGTERM', () => { sseAbort?.abort(); process.exit(0); });
}

main().catch((err) => {
  console.error('Bot fatal:', err);
  process.exit(1);
});
