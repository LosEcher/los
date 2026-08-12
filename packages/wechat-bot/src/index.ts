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
 *   WXPUSHER_UPCALL_ENABLED — explicit opt-in for authenticated inbound commands
 *   LOS_GATEWAY_URL       — los gateway URL (default http://localhost:8080)
 *   WEB_PORT              — mobile web dashboard port (default 8899)
 *
 * Usage (primary):
 *   WECLAW_DEFAULT_TO="user_id@im.wechat" LOS_GATEWAY_URL=http://localhost:8080 \
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
  alertRequiresDecision,
  alertTitle,
  buildAlertMessage,
  buildCompletionMessage,
  buildMediaMessage,
  type OperatorAlert,
} from './presenter/alert-formatter.js';
import {
  weclawSend,
  weclawHealth,
  getWeclawSendHealth,
  startWeclaw,
  stopWeclaw,
  findWeclawBinary,
  installWeclaw,
  isWeclawRunning,
  type WeClawConfig,
  type WeClawSendResult,
} from './bridge/weclaw.js';
import {
  MessageRouter,
  createBuiltinHandlers,
  createTextChannelContext,
  type HandlerDependencies,
  type NormalizerInput,
} from '@los/agent/message-router';
import { loadConfig } from '@los/infra/config';
import { closeDb, initDb } from '@los/infra/db';
import { ensureWxPusherCallbackClaimStore } from './wxpusher-callback-store.js';
import { createWxPusherInboundHandler } from './wxpusher-inbound-handler.js';
import { OperatorAlertDeduper } from './operator-alert-dedupe.js';
import { formatAlertForWeclaw } from './format-alert-weclaw.js';
import {
  classifyCompanionSessionEvent,
  formatWorkerAskReason,
  shouldDeliverToBoundSession,
} from '@los/agent/operator-companion-events';
import { clearBoundSession, loadBoundSession, saveBoundSession } from './session-bind.js';

const runtimeConfig = await loadConfig();

// ── Config ─────────────────────────────────────────────────────────

// WeClaw (primary bidirectional channel)
const WECLAW_API_ADDR = process.env.WECLAW_API_ADDR;
const WECLAW_DEFAULT_TO = process.env.WECLAW_DEFAULT_TO;
// WeClaw auto-install is opt-in (supply-chain safety): only `1` enables it,
// and installWeclaw() additionally requires WECLAW_INSTALL_SHA256 to pin the
// install script. Default is off — install WeClaw manually or pin both vars.
const WECLAW_AUTO_INSTALL = process.env.WECLAW_AUTO_INSTALL === '1';

// WxPusher (fallback notification channel)
const APP_TOKEN = process.env.WXPUSHER_APP_TOKEN;
const UIDS = (process.env.WXPUSHER_UIDS ?? '').split(',').map(s => s.trim()).filter(Boolean);
const TOPIC_IDS = (process.env.WXPUSHER_TOPIC_IDS ?? '').split(',').map(s => Number(s.trim())).filter(n => n > 0);
const WXPUSHER_UPCALL_ENABLED = process.env.WXPUSHER_UPCALL_ENABLED === '1';
const WXPUSHER_APP_ID = process.env.WXPUSHER_APP_ID ? Number(process.env.WXPUSHER_APP_ID) : undefined;
const WXPUSHER_OPERATOR_UIDS = (process.env.WXPUSHER_OPERATOR_UIDS ?? '').split(',').map(s => s.trim()).filter(Boolean);
const WXPUSHER_CALLBACK_PROXY_SECRET = process.env.WXPUSHER_CALLBACK_PROXY_SECRET;
const LOS_WXPUSHER_CALLBACK_TOKEN = process.env.LOS_WXPUSHER_CALLBACK_TOKEN;
const WXPUSHER_CALLBACK_HOST = process.env.WXPUSHER_CALLBACK_HOST ?? '127.0.0.1';

// General
const LOS_GATEWAY_URL = process.env.LOS_GATEWAY_URL ?? 'http://localhost:8080';
const LOS_AUTH_TOKEN = process.env.LOS_AUTH_TOKEN;
const LOS_OPERATOR_TOKEN = process.env.LOS_OPERATOR_TOKEN;
const WEB_PORT = Number(process.env.WEB_PORT ?? 8899);
const CALLBACK_PORT = Number(process.env.WXPUSHER_CALLBACK_PORT ?? process.env.CALLBACK_PORT ?? 0);
const CALLBACK_URL = process.env.WXPUSHER_CALLBACK_URL
  ?? (CALLBACK_PORT > 0 ? `http://${WXPUSHER_CALLBACK_HOST}:${CALLBACK_PORT}` : '');
const CALLBACK_MAX_AGE_MS = process.env.WXPUSHER_CALLBACK_MAX_AGE_MS
  ? Number(process.env.WXPUSHER_CALLBACK_MAX_AGE_MS)
  : undefined;
const CALLBACK_MAX_FUTURE_SKEW_MS = process.env.WXPUSHER_CALLBACK_MAX_FUTURE_SKEW_MS
  ? Number(process.env.WXPUSHER_CALLBACK_MAX_FUTURE_SKEW_MS)
  : undefined;
const CALLBACK_MAX_BODY_BYTES = process.env.WXPUSHER_CALLBACK_MAX_BODY_BYTES
  ? Number(process.env.WXPUSHER_CALLBACK_MAX_BODY_BYTES)
  : undefined;
const SSE_RECONNECT_MS = Number(process.env.SSE_RECONNECT_MS ?? 3000);
const ALERT_DEDUP_MS = 60_000;

const weclawConfig: WeClawConfig = {
  apiAddr: WECLAW_API_ADDR,
  defaultTo: WECLAW_DEFAULT_TO,
  autoInstall: WECLAW_AUTO_INSTALL,
};

function losHeaders(extra: Record<string, string> = {}): Record<string, string> {
  let h = extra;
  if (LOS_AUTH_TOKEN) h = { ...h, 'x-los-auth-token': LOS_AUTH_TOKEN };
  // Operator token is required by /sessions/:id/operator-events (steering /
  // approve-deny-escalate) when the gateway has auth enabled. Send it when
  // configured so the bot's operator actions pass the consent gate.
  if (LOS_OPERATOR_TOKEN) h = { ...h, 'x-los-operator-token': LOS_OPERATOR_TOKEN };
  return h;
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
    callbackHost: WXPUSHER_CALLBACK_HOST,
    callbackUrl: CALLBACK_URL,
    upCallEnabled: WXPUSHER_UPCALL_ENABLED,
    expectedAppId: WXPUSHER_APP_ID,
    operatorUids: WXPUSHER_OPERATOR_UIDS,
    callbackProxySecret: WXPUSHER_CALLBACK_PROXY_SECRET,
    callbackToken: LOS_WXPUSHER_CALLBACK_TOKEN,
    callbackMaxAgeMs: CALLBACK_MAX_AGE_MS,
    callbackMaxFutureSkewMs: CALLBACK_MAX_FUTURE_SKEW_MS,
    callbackMaxBodyBytes: CALLBACK_MAX_BODY_BYTES,
    losGatewayUrl: LOS_GATEWAY_URL,
  }));
}
const wxpusherConfigured = channels.some(channel => channel.kind === 'weixin');

// Web mobile dashboard (always)
channels.push(createWebChannel({
  kind: 'web',
  port: WEB_PORT,
  losGatewayUrl: LOS_GATEWAY_URL,
  losAuthToken: LOS_AUTH_TOKEN,
  losOperatorToken: LOS_OPERATOR_TOKEN,
  healthSnapshot: () => {
    const send = getWeclawSendHealth();
    // HTTP /health alone is false-green when iLink prepare/send is broken.
    const weclawDeliveryReady = weclawAvailable && send.sendHealthy;
    const externalReady = weclawDeliveryReady || wxpusherConfigured;
    return {
      ready: sseLive && externalReady,
      sseConnected: sseLive,
      externalReady,
      weclawAvailable,
      weclawSendHealthy: send.sendHealthy,
      weclawSendFailures: send.consecutiveFailures,
      weclawLastSendError: send.lastError,
      wxpusherConfigured,
    };
  },
}));

// ── Delivery dispatcher ────────────────────────────────────────────

async function deliverAlert(alert: OperatorAlert): Promise<void> {
  console.log(
    `[alert] deliver kind=${alert.kind ?? 'needs_decision'} type=${alert.type} session=${alert.sessionId} run=${alert.runSpecId ?? alert.taskRunId ?? '-'}`,
  );

  let imDelivered = false;
  let weclawError: string | undefined;

  // 1. Try WeClaw first (bidirectional WeChat). Still attempt when HTTP is up
  // even if send health is degraded — a successful send clears the counter.
  if (weclawAvailable && WECLAW_DEFAULT_TO) {
    const text = formatAlertForWeclaw(alert);
    const result = await weclawSend({ text }, weclawConfig);
    if (result.ok) {
      console.log(`[weclaw] sent ok session=${alert.sessionId}`);
      return;
    }
    weclawError = result.error;
    console.error(`[weclaw] send failed: ${result.error}`);
    // Fall through to other channels
  } else if (!WECLAW_DEFAULT_TO) {
    console.warn('[weclaw] skip send: WECLAW_DEFAULT_TO unset');
  }

  // 2. Fallback: WxPusher + Web channels
  for (const channel of channels) {
    try {
      const message = buildAlertMessage(alert, {
        targetChannel: channel.kind,
        gatewayUrl: LOS_GATEWAY_URL,
        callbackUrl: CALLBACK_URL,
      });
      await channel.send(message);
      console.log(`[${channel.kind}] sent ok session=${alert.sessionId}`);
      if (channel.kind === 'weixin') imDelivered = true;
    } catch (err) {
      console.error(`[${channel.kind}] send failed: ${(err as Error).message}`);
    }
  }

  // Daily digest / fleet alerts must not look "delivered" when only the local
  // web event store accepted them — operator IM never saw the message.
  if (
    !imDelivered
    && (alert.type === 'ops.daily_digest' || alert.type === 'ops.fleet_attention')
  ) {
    console.error(
      `[alert] IM delivery failed type=${alert.type} session=${alert.sessionId}`
      + ` weclaw=${weclawError ?? (weclawAvailable ? 'skipped' : 'offline')}`
      + ` wxpusher=${wxpusherConfigured ? 'attempted' : 'not_configured'}`
      + ' — re-login WeClaw (Web #communication-accounts) or configure WxPusher',
    );
  }
}

// ── SSE event consumer ─────────────────────────────────────────────

const alertDeduper = new OperatorAlertDeduper({ semanticTtlMs: ALERT_DEDUP_MS });
let sseAbort: AbortController | null = null;
/** Skip historical catch-up after connect; only live events after operator.ready. */
let sseLive = false;
let lastSseEventId = 0;

async function connectSSE(): Promise<void> {
  if (sseAbort) sseAbort.abort();
  sseAbort = new AbortController();
  sseLive = false;

  try {
    const cursor = lastSseEventId > 0 ? `since=${lastSseEventId}` : 'tail=1';
    const url = `${LOS_GATEWAY_URL}/operator/events/live?${cursor}`;
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
    let currentId = '';
    let currentEvent = '';
    let currentData = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        if (line.startsWith('id: ')) {
          currentId = line.slice(4).trim();
        } else if (line.startsWith('event: ')) {
          currentEvent = line.slice(7).trim();
        } else if (line.startsWith('data: ')) {
          currentData = line.slice(6).trim();
        } else if (line === '' && currentData) {
          if (currentEvent === 'operator.ready') {
            const ready = JSON.parse(currentData) as { lastEventId?: unknown };
            const readyId = Number(ready.lastEventId);
            if (Number.isSafeInteger(readyId) && readyId > lastSseEventId) lastSseEventId = readyId;
            sseLive = true;
            console.log('[events] SSE live — listening for new operator attention');
          } else if (sseLive) {
            await handleSSEEvent(currentEvent, currentData);
            const deliveredId = Number(currentId);
            if (Number.isSafeInteger(deliveredId) && deliveredId > lastSseEventId) {
              lastSseEventId = deliveredId;
            }
          }
          currentId = '';
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

    const payload = (parsed.payload ?? {}) as Record<string, unknown>;
    const sessionId = String(parsed.sessionId ?? '');
    const classification = classifyCompanionSessionEvent({
      type: parsed.type,
      sessionId,
      toolName: parsed.toolName,
      payload,
    });
    if (!classification.shouldNotify) return;

    const bound = loadBoundSession();
    if (!shouldDeliverToBoundSession(bound?.sessionId, sessionId || undefined, {
      allowGlobalOps: true,
      eventType: String(parsed.type ?? ''),
    })) {
      console.log(`[events] skip unbound session type=${parsed.type} session=${sessionId} bound=${bound?.sessionId ?? '-'}`);
      return;
    }

    console.log(`[events] attention type=${parsed.type} session=${sessionId} kind=${classification.kind}`);

    const isGovernanceEvent = String(parsed.type ?? '').startsWith('governance.');
    const isDailyDigest = parsed.type === 'ops.daily_digest';
    const isFleetAttention = parsed.type === 'ops.fleet_attention';

    // Governance digests dedupe by jobType so hourly jobs don't spam.
    // Daily digest dedupes by calendar day so re-pushes within the window collapse.
    // Fleet attention dedupes by node+day (DB also enforces 30m cooldown).
    const dedupKey = isDailyDigest
      ? `ops:daily_digest:${String(payload.day ?? sessionId)}`
      : isFleetAttention
        ? `ops:fleet:${String(payload.nodeId ?? sessionId)}:${String(payload.day ?? '')}`
      : isGovernanceEvent
        ? `gov:${parsed.type}:${String(payload.jobType ?? 'sweep')}`
        : classification.dedupeSuffix
          ? `${sessionId}:${parsed.type}:${classification.dedupeSuffix}`
        : `${sessionId}:${parsed.type}`;

    if (alertDeduper.shouldSuppress({ eventId: parsed.id, fallbackKey: dedupKey })) return;

    const runSpecId =
      (typeof payload.runSpecId === 'string' && payload.runSpecId)
      || (typeof payload.run_spec_id === 'string' && payload.run_spec_id)
      || (typeof payload.entityId === 'string' && String(payload.entityType ?? '').includes('run')
        ? payload.entityId
        : undefined)
      || undefined;
    const taskRunId =
      (typeof payload.taskRunId === 'string' && payload.taskRunId)
      || (typeof payload.task_run_id === 'string' && payload.task_run_id)
      || undefined;

    const toolName = parsed.toolName ?? payload.tool_name;
    const isDenied = classification.kind === 'already_denied';
    const denyKey = isDenied ? `${sessionId}:denied:${toolName ?? 'tool'}` : dedupKey;
    if (isDenied && alertDeduper.shouldSuppress({ fallbackKey: denyKey })) return;

    const govDetail = typeof payload.detail === 'string' ? payload.detail : undefined;
    const govJob = typeof payload.jobType === 'string' ? payload.jobType : undefined;
    const askReason = parsed.type === 'worker.ask' ? formatWorkerAskReason(payload) : undefined;
    const kind = classification.kind === 'success' ? 'info' as const : classification.kind;
    const alert: OperatorAlert = {
      sessionId,
      type: parsed.type,
      toolName: typeof toolName === 'string' ? toolName : undefined,
      reason: askReason
        ?? govDetail
        ?? (typeof payload.reason === 'string' ? payload.reason : undefined)
        ?? (typeof payload.error === 'string' ? payload.error : undefined)
        ?? (govJob ? `job=${govJob}` : undefined)
        ?? parsed.type,
      severity: classification.severity,
      kind,
      title: typeof payload.title === 'string' && payload.title.trim()
        ? payload.title.trim()
        : classification.title,
      callId: (payload.callId ?? payload.call_id) as string | undefined,
      warnings: payload.warnings as string[] | undefined,
      flaggedFiles: payload.flaggedFiles as string[] | undefined,
      runSpecId,
      taskRunId,
    };

    await deliverAlert(alert);
  } catch { /* parse error */ }
}

async function callLosApi(path: string, body: unknown): Promise<{ ok: boolean; status: number; body: any }> {
  const res = await fetch(`${LOS_GATEWAY_URL}${path}`, {
    method: 'POST',
    headers: losHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(body),
  });
  const parsed = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error(`[api] los ${path} error ${res.status}: ${JSON.stringify(parsed).slice(0, 200)}`);
  }
  return { ok: res.ok, status: res.status, body: parsed };
}

// ── MessageRouter helpers ───────────────────────────────────────────

function channelToSourceKind(kind: string): 'wx-weixin' | 'wx-web' {
  switch (kind) {
    case 'weixin': return 'wx-weixin';
    case 'web':    return 'wx-web';
    default:       return 'wx-weixin';
  }
}

async function tryHandleSessionBindCommand(ch: Channel, text: string): Promise<boolean> {
  const bind = text.trim().match(/^#bind-session\s+(?<sid>[\w-]{8,96})\s*$/i);
  if (bind?.groups?.sid) {
    const state = saveBoundSession(bind.groups.sid);
    await sendTextToChannel(ch, `✅ 已绑定会话 ${state.sessionId}\n之后只推送该会话（+ 全局 ops/governance）。\n解除: #unbind-session`);
    return true;
  }
  if (/^#unbind-session\s*$/i.test(text.trim())) {
    clearBoundSession();
    await sendTextToChannel(ch, '✅ 已解除会话绑定；恢复推送全部会话。');
    return true;
  }
  if (/^#bound-session\s*$/i.test(text.trim())) {
    const state = loadBoundSession();
    await sendTextToChannel(
      ch,
      state
        ? `当前绑定: ${state.sessionId}\nsource=${state.source} boundAt=${state.boundAt}`
        : '当前未绑定会话（推送全部）。可用 #bind-session <sessionId>',
    );
    return true;
  }
  return false;
}

async function sendTextToChannel(ch: Channel, text: string): Promise<void> {
  const msg: UnifiedMessage = {
    id: `router-${Date.now()}`,
    type: MessageType.TEXT,
    version: '1.0',
    text,
    routing: {
      priority: MessagePriority.NORMAL,
      recipient: null,
      replyTo: null,
      channel: ch.kind,
    },
    metadata: {
      timestamp: new Date().toISOString(),
      source: 'message-router',
      channel: ch.kind,
    },
    _internal: { standardizedAt: new Date().toISOString(), compressed: false, size: text.length },
  };
  await ch.send(msg);
}

let messageRouter: MessageRouter; // backward compat, set in main()

// ── Main ───────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('🤖 los Multi-Channel Bot starting\n');

  await initDb(runtimeConfig.databaseUrl);
  await ensureWxPusherCallbackClaimStore();

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
      console.log('  [weclaw] not found — install manually, or enable hash-verified auto-install:');
      console.log('  [weclaw]   WECLAW_AUTO_INSTALL=1 + WECLAW_INSTALL_SHA256=<sha256 of install.sh>');
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
  console.log(`  WxPusher: ${wxpusherConfigured ? '✅ configured' : '⚠️ not configured'}`);
  console.log('');

  // 2.5 Wire MessageRouter — handles inbound commands from all channels
  const routerChannels = channels.map(ch =>
    createTextChannelContext(ch.kind, `${ch.kind}-bot`, async (text) => {
      await sendTextToChannel(ch, text);
      return { ok: true };
    }),
  );

  const router = new MessageRouter({
    channels: routerChannels,
    defaultChannelId: routerChannels[0]?.id ?? null,
    handlers: createBuiltinHandlers({
      config: {} as any,
      dispatchTodo: async (todoId, opts) =>
        callLosApi(`/todos/${encodeURIComponent(todoId)}/dispatch`, { force: opts?.force ?? false }),
    }),
  });
  const wxpusherInboundHandler = createWxPusherInboundHandler(router);

  // Register inbound message handlers on each channel
  for (const ch of channels) {
    if (ch.capabilities.upCall) {
      if (ch.kind === 'weixin') {
        ch.onMessage(async (msg: UnifiedMessage) => {
          if (await tryHandleSessionBindCommand(ch, msg.text ?? '')) return;
          await wxpusherInboundHandler(msg);
        });
        console.log(`  [${ch.kind}] ✅ inbound handler registered`);
        continue;
      }
      ch.onMessage(async (msg: UnifiedMessage) => {
        try {
          if (await tryHandleSessionBindCommand(ch, msg.text ?? '')) return;
          await router.route({ sourceKind: 'wx-web', action: msg.text, sessionId: msg.metadata.sessionId ?? '' });
        } catch (err) {
          console.error(`[router] ${ch.kind} failed: ${(err as Error).message}`);
        }
      });
      console.log(`  [${ch.kind}] ✅ inbound handler registered`);
    }
  }

  const bound = loadBoundSession();
  if (bound) {
    console.log(`  Bound session: ${bound.sessionId} (source=${bound.source})`);
  } else {
    console.log('  Bound session: (none — all sessions pushed; use #bind-session <id>)');
  }

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
    await closeDb().catch(() => undefined);
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
