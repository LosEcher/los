/**
 * @los/wechat-bot — Multi-channel agent handoff: WeClaw + WxPusher + mobile web.
 *
 * Architecture:
 *   los gateway SSE → EventConsumer → Channel.send(message)
 *       ├─ weclaw (WeClaw HTTP API → WeChat iLink — bidirectional)
 *       ├─ weixin (WxPusher push → WeChat — fallback, notification only)
 *       └─ web   (mobile dashboard at /m/ — always available)
 *
 * WeClaw is the primary WeChat channel: QR login, bidirectional messaging,
 * text + image/video/file send, voice transcription, multi-agent routing.
 * WxPusher is the fallback: pure push, no interactive commands needed.
 *
 * Media: @los/media package for TTS/image/video generation and delivery.
 * When WeClaw receives a media request, los media runtime generates the
 * content and delivers it via WeClaw's HTTP API.
 *
 * Requirements:
 *   WECLAW_API_ADDR       — WeClaw API address (default 127.0.0.1:18011)
 *   WECLAW_DEFAULT_TO     — WeChat user ID for outbound messages
 *   WXPUSHER_APP_TOKEN    — WxPusher appToken (optional fallback)
 *   WXPUSHER_UIDS         — comma-separated UIDs (optional fallback)
 *   LOS_GATEWAY_URL       — los gateway URL (default http://localhost:3000)
 *   WEB_PORT              — mobile web dashboard port (default 8899)
 *
 * Usage (primary):
 *   WECLAW_DEFAULT_TO="user_id@im.wechat" LOS_GATEWAY_URL=http://localhost:3000 \
 *   node packages/wechat-bot/src/index.js
 *
 * Then open http://localhost:8899/m/ on your phone.
 */

import {
  createWeixinChannel,
  createWebChannel,
  MessageType,
  MessagePriority,
  type Channel,
  type UnifiedMessage,
} from './channel/index.js';
import {
  buildAlertMessage,
  buildCompletionMessage,
  buildMediaMessage,
  type OperatorAlert,
} from './presenter/alert-formatter.js';
import {
  weclawSend,
  weclawHealth,
  startWeclaw,
  stopWeclaw,
  findWeclawBinary,
  installWeclaw,
  isWeclawRunning,
  type WeClawConfig,
  type WeClawSendResult,
} from './bridge/weclaw.js';

// ── Config ─────────────────────────────────────────────────────────

// WeClaw (primary bidirectional channel)
const WECLAW_API_ADDR = process.env.WECLAW_API_ADDR;
const WECLAW_DEFAULT_TO = process.env.WECLAW_DEFAULT_TO;
const WECLAW_AUTO_INSTALL = process.env.WECLAW_AUTO_INSTALL !== '0';

// WxPusher (fallback notification channel)
const APP_TOKEN = process.env.WXPUSHER_APP_TOKEN;
const UIDS = (process.env.WXPUSHER_UIDS ?? '').split(',').map(s => s.trim()).filter(Boolean);
const TOPIC_IDS = (process.env.WXPUSHER_TOPIC_IDS ?? '').split(',').map(s => Number(s.trim())).filter(n => n > 0);

// General
const LOS_GATEWAY_URL = process.env.LOS_GATEWAY_URL ?? 'http://localhost:3000';
const LOS_AUTH_TOKEN = process.env.LOS_AUTH_TOKEN;
const WEB_PORT = Number(process.env.WEB_PORT ?? 8899);
const CALLBACK_PORT = Number(process.env.CALLBACK_PORT ?? 0);
const SSE_RECONNECT_MS = Number(process.env.SSE_RECONNECT_MS ?? 3000);
const ALERT_DEDUP_MS = 60_000;

const weclawConfig: WeClawConfig = {
  apiAddr: WECLAW_API_ADDR,
  defaultTo: WECLAW_DEFAULT_TO,
  autoInstall: WECLAW_AUTO_INSTALL,
};

function losHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return LOS_AUTH_TOKEN ? { ...extra, 'x-los-auth-token': LOS_AUTH_TOKEN } : extra;
}

// ── Channels ───────────────────────────────────────────────────────

const channels: Channel[] = [];

// WeChat via WeClaw (primary)
// WeClaw is not a Channel in the typed sense — it's an external Go process
// with an HTTP API. We use weclawSend() directly for outbound.
let weclawAvailable = false;

// WxPusher (fallback)
if (APP_TOKEN && (UIDS.length > 0 || TOPIC_IDS.length > 0)) {
  channels.push(createWeixinChannel({
    kind: 'weixin',
    appToken: APP_TOKEN,
    uids: UIDS,
    topicIds: TOPIC_IDS,
    callbackPort: CALLBACK_PORT,
    callbackUrl: CALLBACK_PORT > 0 ? `http://localhost:${CALLBACK_PORT}` : '',
    losGatewayUrl: LOS_GATEWAY_URL,
  }));
}

// Web mobile dashboard (always)
channels.push(createWebChannel({
  kind: 'web',
  port: WEB_PORT,
  losGatewayUrl: LOS_GATEWAY_URL,
  losAuthToken: LOS_AUTH_TOKEN,
}));

// ── Delivery dispatcher ────────────────────────────────────────────

async function deliverAlert(alert: OperatorAlert): Promise<void> {
  // 1. Try WeClaw first (bidirectional WeChat)
  if (weclawAvailable && WECLAW_DEFAULT_TO) {
    const text = formatAlertForWeclaw(alert);
    const result = await weclawSend({ text }, weclawConfig);
    if (result.ok) return;
    console.error(`[weclaw] send failed: ${result.error}`);
    // Fall through to other channels
  }

  // 2. Fallback: WxPusher + Web channels
  for (const channel of channels) {
    try {
      const message = buildAlertMessage(alert, {
        targetChannel: channel.kind,
        gatewayUrl: LOS_GATEWAY_URL,
        callbackUrl: CALLBACK_PORT > 0 ? `http://localhost:${CALLBACK_PORT}` : '',
      });
      await channel.send(message);
    } catch (err) {
      console.error(`[${channel.kind}] send failed: ${(err as Error).message}`);
    }
  }
}

function formatAlertForWeclaw(alert: OperatorAlert): string {
  const icon = alert.severity === 'critical' ? '🔴' : alert.severity === 'warning' ? '⚠️' : 'ℹ️';
  let text = `${icon} Agent needs decision`;

  if (alert.toolName) text += `\nTool: ${alert.toolName}`;
  if (alert.reason) text += `\nReason: ${alert.reason}`;

  if (alert.warnings?.length) {
    for (const w of alert.warnings.slice(0, 3)) {
      text += `\n⚠ ${w}`;
    }
  }
  if (alert.flaggedFiles?.length) {
    text += `\n📁 ${alert.flaggedFiles.slice(0, 3).join(', ')}`;
  }

  // Action commands for WeClaw up-call
  text += `\n\nSession: ${alert.sessionId.slice(0, 8)}...`;
  text += `\nReply #approve ${alert.sessionId.slice(0, 8)}`;
  text += ` or #deny ${alert.sessionId.slice(0, 8)}`;
  text += ` or #escalate ${alert.sessionId.slice(0, 8)}`;
  text += ` or #status ${alert.sessionId.slice(0, 8)}`;

  return text;
}

// ── SSE event consumer ─────────────────────────────────────────────

const recentAlerts = new Map<string, number>();
let sseAbort: AbortController | null = null;

async function connectSSE(): Promise<void> {
  if (sseAbort) sseAbort.abort();
  sseAbort = new AbortController();

  try {
    // Try the session-aware SSE endpoint first
    const url = `${LOS_GATEWAY_URL}/operator/events/live`;
    console.log(`[events] SSE connecting: ${url}`);

    const res = await fetch(url, {
      headers: losHeaders({ 'Accept': 'text/event-stream' }),
      signal: sseAbort.signal,
    });

    if (!res.ok || !res.body) {
      console.error(`[events] SSE failed: ${res.status}`);
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
          await handleSSEEvent(currentEvent, currentData);
          currentEvent = '';
          currentData = '';
        }
      }
    }
  } catch (err: any) {
    if (err.name === 'AbortError') return;
    console.error(`[events] SSE error: ${err.message}`);
  }

  setTimeout(connectSSE, SSE_RECONNECT_MS);
}

async function handleSSEEvent(eventType: string, data: string): Promise<void> {
  try {
    const parsed = JSON.parse(data);
    if (eventType !== 'session.event') return;

    const payload = parsed.payload ?? {};
    const isOperatorAttention =
      parsed.type === 'tool.warned' ||
      parsed.type === 'tool.denied' ||
      parsed.type === 'operator_attention' ||
      (parsed.type === 'execution:transition' && payload.to === 'operator_attention') ||
      parsed.type === 'session.blocked' ||
      parsed.type === 'session.error';

    if (!isOperatorAttention) return;

    const sessionId = parsed.sessionId ?? '';
    const dedupKey = `${sessionId}:${parsed.type}`;

    if (recentAlerts.get(dedupKey) && Date.now() - recentAlerts.get(dedupKey)! < ALERT_DEDUP_MS) return;
    recentAlerts.set(dedupKey, Date.now());

    // Cleanup old entries
    if (recentAlerts.size > 1000) {
      for (const [k, ts] of recentAlerts) {
        if (Date.now() - ts > ALERT_DEDUP_MS * 2) recentAlerts.delete(k);
      }
    }

    const alert: OperatorAlert = {
      sessionId,
      type: parsed.type,
      toolName: parsed.toolName ?? payload.tool_name,
      reason: payload.reason ?? payload.error ?? parsed.type,
      severity: parsed.type === 'session.error' || payload.knownFailure ? 'critical' :
                parsed.type === 'tool.warned' ? 'warning' : 'info',
      callId: payload.callId ?? payload.call_id,
      warnings: payload.warnings,
      flaggedFiles: payload.flaggedFiles,
    };

    await deliverAlert(alert);
  } catch { /* parse error */ }
}

async function callLosApi(path: string, body: unknown): Promise<void> {
  const res = await fetch(`${LOS_GATEWAY_URL}${path}`, {
    method: 'POST',
    headers: losHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    console.error(`[api] los ${path} error ${res.status}: ${text.slice(0, 200)}`);
  }
}

// ── Main ───────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('🤖 los Multi-Channel Bot starting\n');

  // 1. Initialize WeClaw
  const binary = findWeclawBinary();
  if (binary) {
    console.log(`  [weclaw] binary: ${binary}`);
    const running = isWeclawRunning();

    if (!running) {
      console.log('  [weclaw] starting daemon...');
      const started = startWeclaw(weclawConfig);
      if (started.ok) {
        console.log(`  [weclaw] ✅ started (pid=${started.pid})`);
      } else {
        console.log(`  [weclaw] ⚠️ start failed: ${started.error}`);
      }
    } else {
      console.log('  [weclaw] ✅ already running');
    }

    // Verify API reachable
    const healthy = await weclawHealth(weclawConfig);
    weclawAvailable = healthy;
    if (healthy) {
      console.log('  [weclaw] API healthy — bidirectional WeChat enabled');
    } else {
      console.log('  [weclaw] ⚠️ API not reachable — will retry on each send');
    }
  } else {
    if (WECLAW_AUTO_INSTALL) {
      console.log('  [weclaw] not found — auto-installing...');
      const installed = installWeclaw();
      if (installed.ok) {
        console.log(`  [weclaw] installed: ${installed.path}`);
        const started = startWeclaw(weclawConfig);
        if (started.ok) {
          console.log(`  [weclaw] ⚠️ started — scan QR code with WeChat to login`);
          // Wait for API to come up
          for (let i = 0; i < 10; i++) {
            await new Promise(r => setTimeout(r, 2000));
            const healthy = await weclawHealth(weclawConfig);
            if (healthy) { weclawAvailable = true; break; }
          }
          if (weclawAvailable) console.log('  [weclaw] API healthy');
          else console.log('  [weclaw] ⚠️ API still unreachable after install — QR login may be needed');
        }
      } else {
        console.log(`  [weclaw] ⚠️ install failed: ${installed.error}`);
      }
    } else {
      console.log('  [weclaw] not found — set WECLAW_AUTO_INSTALL=1 or install manually');
      console.log('  [weclaw] Install: curl -sSL https://raw.githubusercontent.com/fastclaw-ai/weclaw/main/install.sh | sh');
    }
  }

  // 2. Start channels (web dashboard always, WxPusher if configured)
  for (const ch of channels) {
    try {
      const result = await ch.start();
      console.log(`  [${ch.kind}] ${result.ok ? '✅ started' : '❌ failed'}`);
    } catch (err) {
      console.error(`  [${ch.kind}] start error: ${(err as Error).message}`);
    }
  }

  if (!weclawAvailable && channels.length === 0) {
    console.error('\n❌ No channels available. Configure WeClaw or WxPusher.');
    process.exit(1);
  }

  console.log(`\n  Mobile: http://localhost:${WEB_PORT}/m/`);
  console.log(`  WeClaw: ${weclawAvailable ? '✅ active' : '⚠️ offline'}`);
  console.log(`  WxPusher: ${channels.some(c => c.kind === 'weixin') ? '✅ configured' : '⚠️ not configured'}`);
  console.log('');

  // 3. Connect SSE
  connectSSE();

  // Graceful shutdown
  const shutdown = async () => {
    console.log('\nShutting down...');
    sseAbort?.abort();
    stopWeclaw();
    for (const ch of channels) {
      try { await ch.stop(); } catch { /* best-effort */ }
    }
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
