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
 *   TELEGRAM_CHAT_ID    — target chat (can be set via /start)
 *   LOS_GATEWAY_URL     — los gateway base URL (default http://localhost:8080)
 *
 * Usage:
 *   TELEGRAM_BOT_TOKEN=xxx TELEGRAM_CHAT_ID=123 LOS_GATEWAY_URL=http://localhost:8080 node packages/telegram-bot/src/index.js
 */

import { createServer } from 'node:http';
import { resolveIntent } from '@los/agent/message-router';

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

interface TgMessage {
  message_id: number;
  chat: { id: number };
  text?: string;
  callback_query?: {
    id: string;
    message: TgMessage;
    data: string;
  };
}

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

// ── Authorized chat tracking ───────────────────────────────────────

const authorizedChats = new Set<number>();
const initialChatId = process.env.TELEGRAM_CHAT_ID ? Number(process.env.TELEGRAM_CHAT_ID) : null;
if (initialChatId) authorizedChats.add(initialChatId);

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

async function connectSSE(): Promise<void> {
  if (sseAbort) sseAbort.abort();
  sseAbort = new AbortController();

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

    const chatIds = authorizedChats.size > 0
      ? [...authorizedChats]
      : [initialChatId].filter(Boolean) as number[];

    if (chatIds.length === 0) {
      console.log(`No authorized chats — skipping alert for ${sessionId}`);
      return;
    }

    for (const chatId of chatIds) {
      await sendMessage(chatId, formatAlert(alert), [
        [
          { text: '✅ Approve', callback_data: `approve:${sessionId}:${alert.payload.callId ?? ''}` },
          { text: '❌ Deny', callback_data: `deny:${sessionId}:${alert.payload.callId ?? ''}` },
        ],
        [
          { text: '↗ Escalate', callback_data: `escalate:${sessionId}:${alert.payload.callId ?? ''}` },
        ],
      ]);
    }
  } catch {
    // Parse error — skip
  }
}

// ── Operator action handlers ────────────────────────────────────────

async function handleApprove(sessionId: string, callId: string): Promise<string> {
  const res = await fetch(`${LOS_GATEWAY_URL}/sessions/${encodeURIComponent(sessionId)}/operator-events`, {
    method: 'POST',
    headers: losHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({
      type: 'steering',
      instruction: `Approved via Telegram${callId ? `: callId=${callId}` : ''}`,
      turnBoundary: 'immediate',
      actor: 'telegram-bot',
      reason: 'operator_approval',
    }),
  });
  if (!res.ok) return `Approve failed: ${res.status}`;
  return '✅ Approved';
}

async function handleDeny(sessionId: string, callId: string): Promise<string> {
  const res = await fetch(`${LOS_GATEWAY_URL}/sessions/${encodeURIComponent(sessionId)}/operator-events`, {
    method: 'POST',
    headers: losHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({
      type: 'steering',
      instruction: `Denied via Telegram${callId ? `: callId=${callId}` : ''}`,
      turnBoundary: 'immediate',
      actor: 'telegram-bot',
      reason: 'operator_denial',
    }),
  });
  if (!res.ok) return `Deny failed: ${res.status}`;
  return '❌ Denied';
}

async function handleEscalate(sessionId: string, callId: string): Promise<string> {
  // Record escalate as operator.followup
  const res = await fetch(`${LOS_GATEWAY_URL}/sessions/${encodeURIComponent(sessionId)}/operator-events`, {
    method: 'POST',
    headers: losHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({
      type: 'steering',
      instruction: `Escalated from Telegram: session=${sessionId} callId=${callId}`,
      turnBoundary: 'immediate',
      actor: 'telegram-bot',
      reason: 'operator_escalation',
    }),
  });
  if (!res.ok) return `Escalate failed: ${res.status}`;
  return '↗ Escalated to operator queue';
}

// ── Webhook server for Telegram callbacks ───────────────────────────

async function handleCallback(callbackQuery: NonNullable<TgMessage['callback_query']>): Promise<void> {
  const data = callbackQuery.data;
  const [action, sessionId, callId] = data.split(':');

  // Check for #command prefix (e.g. someone types "#status abc123" as a message)
  let response: string;
  if (data.startsWith('#')) {
    const intent = resolveIntent(data);
    response = await handleResolvedIntent(intent, sessionId, callId);
  } else {
    switch (action) {
      case 'approve': response = await handleApprove(sessionId, callId); break;
      case 'deny': response = await handleDeny(sessionId, callId); break;
      case 'escalate': response = await handleEscalate(sessionId, callId); break;
      default: response = `Unknown action: ${action}`;
    }
  }

  await answerCallback(callbackQuery.id, response);
}

async function handleResolvedIntent(
  intent: ReturnType<typeof resolveIntent>,
  sessionId: string,
  callId: string,
): Promise<string> {
  switch (intent.type) {
    case 'steering':
      return intent.instruction === 'approve' ? await handleApprove(intent.sessionId, callId)
        : intent.instruction === 'deny' ? await handleDeny(intent.sessionId, callId)
        : await handleEscalate(intent.sessionId, callId);
    case 'status':
      // Fall through to HTTP call for status (telegram-bot doesn't have DB access)
      return `📊 Status for ${intent.sessionId.slice(0, 8)}… — check the gateway or #status in chat.`;
    case 'chat':
      return `💬 To start a chat, use #claude <prompt> or #codex <prompt>.`;
    case 'runtime':
      return `🔄 Runtime agents are available via #claude <prompt> or #codex <prompt> in WeChat.`;
    case 'todo':
      return `📋 Todo commands are available via #task in WeChat.`;
    default:
      return `Unknown intent: ${intent.type}`;
  }
}

// ── Main ───────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log(`🤖 los Telegram Bot starting`);
  console.log(`   Gateway: ${LOS_GATEWAY_URL}`);
  console.log(`   Chats: ${authorizedChats.size > 0 ? [...authorizedChats].join(', ') : '(none — waiting for /start)'}`);

  if (WEBHOOK_PORT > 0) {
    // Webhook mode: Telegram sends updates to this server
    const server = createServer(async (req, res) => {
      if (req.method === 'POST' && req.url === '/telegram-webhook') {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
        const body = JSON.parse(Buffer.concat(chunks).toString('utf-8'));

        if (body.message?.text === '/start') {
          authorizedChats.add(body.message.chat.id);
          await sendMessage(body.message.chat.id, '✅ los agent alerts enabled. You will receive operator_attention notifications here.');
          console.log(`Authorized chat: ${body.message.chat.id}`);
        } else if (body.callback_query) {
          await handleCallback(body.callback_query);
        }
        res.writeHead(200);
        res.end('ok');
        return;
      }
      res.writeHead(404);
      res.end();
    });

    server.listen(WEBHOOK_PORT, () => {
      console.log(`Webhook listening on port ${WEBHOOK_PORT}`);
    });
    await tgApi('setWebhook', { url: `${process.env.WEBHOOK_URL ?? `http://localhost:${WEBHOOK_PORT}`}/telegram-webhook` });
  } else {
    // Polling mode: check for updates periodically
    console.log('Polling mode (no webhook port configured)');

    const POLL_INTERVAL_MS = Number(process.env.TELEGRAM_POLL_INTERVAL ?? 5000);
    let lastUpdateId = 0;

    setInterval(async () => {
      try {
        const result = await tgApi('getUpdates', { offset: lastUpdateId + 1, timeout: 5 });
        const updates = (result as any)?.result ?? [];
        for (const update of updates) {
          lastUpdateId = Math.max(lastUpdateId, update.update_id);
          if (update.message?.text === '/start') {
            authorizedChats.add(update.message.chat.id);
            await sendMessage(update.message.chat.id, '✅ los agent alerts enabled. You will receive operator_attention notifications here.');
            console.log(`Authorized chat: ${update.message.chat.id}`);
          } else if (update.callback_query) {
            await handleCallback(update.callback_query);
          }
        }
      } catch (err) {
        // Non-fatal — Telegram API can be flaky
      }
    }, POLL_INTERVAL_MS);
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
