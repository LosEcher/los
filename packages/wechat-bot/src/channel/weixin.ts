/**
 * @los/wechat-bot/channel/weixin — WxPusher WeChat channel implementation.
 *
 * Supports text, image, file, video delivery (HTML cards with media links),
 * up-call commands via WxPusher callback, and mobile web action links.
 *
 * Media: WxPusher's free tier delivers HTML content. Images/files/videos
 * are embedded as links in HTML messages. The mobile web callback server
 * provides a full action UI for approve/deny/escalate operations.
 */

import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import type {
  Channel,
  ChannelCapabilities,
  ChannelKind,
  ChannelSendResult,
  UnifiedMessage,
} from './types.js';

const WXPUSHER_API = 'https://wxpusher.zjiecode.com/api';
const DEFAULT_CAPABILITIES: ChannelCapabilities = {
  text: true,
  image: true,        // HTML <img> links
  video: false,       // WxPusher doesn't directly support video upload
  file: false,        // WxPusher doesn't directly support file upload
  actions: false,     // HTML links instead of native buttons
  richText: true,     // HTML (contentType=2)
  upCall: true,       // WxPusher callback with #commands
  mobileWeb: true,    // Callback server provides mobile action pages
  maxTextLength: 40000,
  maxMediaSize: 0,    // Not applicable (links only)
};

export interface WeixinChannelConfig {
  kind: 'weixin';
  appToken?: string;
  uids: string[];
  topicIds?: number[];
  callbackPort?: number;
  callbackUrl?: string;
  losGatewayUrl: string;
}

export function createWeixinChannel(config: WeixinChannelConfig): Channel {
  const { appToken, uids, topicIds = [], callbackPort = 0, callbackUrl = '', losGatewayUrl } = config;

  const messageHandlers = new Set<(msg: UnifiedMessage) => void | Promise<void>>();
  let server: ReturnType<typeof createServer> | null = null;

  // ── Channel implementation ─────────────────────────────

  const channel: Channel = {
    kind: 'weixin' as ChannelKind,
    capabilities: { ...DEFAULT_CAPABILITIES },

    async start() {
      if (callbackPort > 0) {
        server = createServer(async (req, res) => {
          // ── WxPusher up-call callback ────────────────
          if (req.method === 'POST' && req.url === '/wxpusher-callback') {
            const chunks: Buffer[] = [];
            for await (const chunk of req) chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
            try {
              const body = JSON.parse(Buffer.concat(chunks).toString('utf-8')) as {
                action: string;
                data: { uid: string; appId: number; appName: string; time: number; content: string };
              };

              if (body.action === 'send_up_cmd') {
                const msg: UnifiedMessage = {
                  id: `wx-up-${Date.now()}`,
                  type: 'COMMAND',
                  version: '1.0',
                  text: body.data.content ?? '',
                  routing: {
                    priority: 'NORMAL',
                    recipient: body.data.uid ?? '',
                    replyTo: null,
                    channel: 'weixin',
                  },
                  metadata: {
                    timestamp: new Date().toISOString(),
                    source: 'wxpusher-callback',
                    channel: 'weixin',
                    tags: ['up-call'],
                  },
                  _internal: {
                    standardizedAt: new Date().toISOString(),
                    compressed: false,
                    size: 0,
                  },
                };

                for (const handler of messageHandlers) {
                  try { await handler(msg); } catch { /* best-effort */ }
                }
              }

              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ ok: true }));
            } catch {
              res.writeHead(400);
              res.end('invalid json');
            }
            return;
          }

          // ── Mobile web action pages ──────────────────
          if (req.method === 'GET' && req.url?.startsWith('/m/')) {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(renderMobileActionPage(req.url));
            return;
          }

          res.writeHead(404);
          res.end();
        });

        await new Promise<void>((resolve) => server!.listen(callbackPort, resolve));
        console.log(`[weixin] Callback server on port ${callbackPort}`);
        if (callbackUrl) {
          console.log(`[weixin] WxPusher callback URL: ${callbackUrl}/wxpusher-callback`);
        }
      }
      return { ok: true };
    },

    async stop() {
      if (server) {
        await new Promise<void>((resolve) => server!.close(() => resolve()));
        server = null;
      }
      return { ok: true };
    },

    async send(message: UnifiedMessage): Promise<ChannelSendResult> {
      if (!appToken) {
        return { ok: false, error: 'no_app_token', channel: 'weixin' };
      }
      if (uids.length === 0 && topicIds.length === 0) {
        return { ok: false, error: 'no_recipients', channel: 'weixin' };
      }

      const html = formatToWeixinHtml(message, { callbackUrl, losGatewayUrl });

      try {
        const body: Record<string, unknown> = {
          appToken,
          content: html,
          summary: (message.summary ?? message.text).slice(0, 100),
          contentType: 2, // HTML
        };
        if (uids.length > 0) body.uids = uids;
        if (topicIds.length > 0) body.topicIds = topicIds;

        const res = await fetch(`${WXPUSHER_API}/send/message`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });

        const data = await res.json() as Record<string, unknown>;
        const ok = data?.success === true || data?.code === 1000;

        if (!ok) {
          console.error(`[weixin] Push failed: ${JSON.stringify(data)}`);
          return { ok: false, error: `api_error:${data?.code ?? 'unknown'}`, channel: 'weixin' };
        }

        return { ok: true, messageId: message.id, channel: 'weixin' };
      } catch (err) {
        return { ok: false, error: (err as Error).message, channel: 'weixin' };
      }
    },

    async sendCard(message: UnifiedMessage): Promise<ChannelSendResult> {
      // Cards are HTML with action links in WxPusher
      return channel.send(message);
    },

    onMessage(handler) {
      messageHandlers.add(handler);
      return () => { messageHandlers.delete(handler); };
    },

    async health() {
      if (!appToken) return { healthy: false, message: 'no appToken configured' };
      if (uids.length === 0 && topicIds.length === 0) return { healthy: false, message: 'no recipients configured' };
      // Check WxPusher reachability
      try {
        const res = await fetch(`${WXPUSHER_API}/send/message?appToken=${appToken}&content=health&uid=${uids[0]}&contentType=1`, { method: 'GET' });
        return res.ok ? { healthy: true, message: 'ok' } : { healthy: false, message: `API status ${res.status}` };
      } catch {
        return { healthy: false, message: 'unreachable' };
      }
    },
  };

  return channel;
}

// ── Message → WxPusher HTML ────────────────────────────────────────

function formatToWeixinHtml(
  msg: UnifiedMessage,
  opts: { callbackUrl: string; losGatewayUrl: string }
): string {
  const severityIcon = msg.routing.priority === 'CRITICAL' ? '🔴'
    : msg.routing.priority === 'HIGH' ? '⚠️' : 'ℹ️';

  let html = `${severityIcon} <b>${escapeH(msg.text.split('\n')[0] ?? msg.text)}</b>`;

  // Full text body
  const bodyText = msg.text.includes('\n') ? msg.text.slice(msg.text.indexOf('\n') + 1) : '';
  if (bodyText) {
    html += `<br/><blockquote>${escapeH(bodyText).replace(/\n/g, '<br/>')}</blockquote>`;
  }

  // Media items
  if (msg.mediaList && msg.mediaList.length > 0) {
    html += '<br/>';
    for (const media of msg.mediaList) {
      if (media.type === 'image' && media.url) {
        html += `<br/>📷 <a href="${escapeH(media.url)}">${escapeH(media.fileName ?? 'Image')}</a>`;
      } else if (media.type === 'video' && media.url) {
        html += `<br/>🎬 <a href="${escapeH(media.url)}">${escapeH(media.fileName ?? 'Video')}</a>`;
      } else if (media.type === 'file' && media.url) {
        html += `<br/>📁 <a href="${escapeH(media.url)}">${escapeH(media.fileName ?? 'File')} (${formatSize(media.size ?? 0)})</a>`;
      } else if (media.type === 'audio' && media.url) {
        html += `<br/>🎵 <a href="${escapeH(media.url)}">${escapeH(media.fileName ?? 'Audio')}</a>`;
      }
    }
  } else if (msg.media?.url) {
    if (msg.media.type === 'image') {
      html += `<br/><br/>📷 <a href="${escapeH(msg.media.url)}">View Image</a>`;
    } else if (msg.media.type === 'video') {
      html += `<br/><br/>🎬 <a href="${escapeH(msg.media.url)}">View Video</a>`;
    }
  }

  // Metadata footer
  if (msg.metadata.sessionId) {
    html += `<br/><br/><small>Session: ${msg.metadata.sessionId.slice(0, 8)}...</small>`;
  }

  // Action links → mobile web pages
  if (msg.actions && msg.actions.length > 0 && opts.callbackUrl) {
    html += '<br/><br/>';
    const sessionId = msg.metadata.sessionId ?? '';
    const callId = msg.metadata.taskRunId ?? '';
    for (const action of msg.actions) {
      const actionUrl = `${opts.callbackUrl}/m/action?action=${encodeURIComponent(action.value)}&sessionId=${sessionId}&callId=${callId}`;
      const color = action.type === 'danger' ? 'color:red;' : action.type === 'primary' ? 'color:green;' : '';
      html += `<a href="${escapeH(actionUrl)}" style="${color}font-weight:bold;">[${escapeH(action.text)}]</a> &nbsp;`;
    }
  }

  // Command hint
  if (msg.actions && msg.actions.length > 0) {
    html += '<br/><small>Reply commands: #approve #deny #escalate #status</small>';
  }

  return html;
}

// ── Mobile web action page ─────────────────────────────────────────

function renderMobileActionPage(rawUrl: string): string {
  const url = new URL(rawUrl, 'http://localhost');
  const params = url.searchParams;
  const action = params.get('action') ?? '';
  const sessionId = params.get('sessionId') ?? '';
  const callId = params.get('callId') ?? '';

  let title = 'Action';
  let description = '';
  switch (action) {
    case 'approve':
      title = '✅ Approve';
      description = 'The tool call will be approved.';
      break;
    case 'deny':
      title = '❌ Deny';
      description = 'The tool call will be denied.';
      break;
    case 'escalate':
      title = '↗ Escalate';
      description = 'Escalated to the operator queue.';
      break;
    case 'status':
      title = '📊 Status';
      description = 'Checking session status...';
      break;
  }

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="mobile-web-app-capable" content="yes">
<title>los Agent</title>
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
         background: #0f172a; color: #e2e8f0; min-height: 100vh;
         display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 24px; }
  .card { background: #1e293b; border-radius: 16px; padding: 32px 24px;
          max-width: 360px; width: 100%; text-align: center;
          box-shadow: 0 4px 24px rgba(0,0,0,0.4); }
  h1 { font-size: 28px; margin-bottom: 8px; }
  p { color: #94a3b8; font-size: 14px; margin-bottom: 24px; line-height: 1.5; }
  .code { font-family: "SF Mono", monospace; font-size: 12px; color: #64748b;
          background: #0f172a; padding: 8px 12px; border-radius: 8px;
          word-break: break-all; margin-bottom: 24px; }
  .actions { display: flex; flex-direction: column; gap: 12px; width: 100%; }
  .btn { display: block; width: 100%; padding: 14px; border: none; border-radius: 12px;
         font-size: 16px; font-weight: 600; cursor: pointer; text-align: center;
         text-decoration: none; transition: opacity 0.15s; }
  .btn:active { opacity: 0.8; }
  .btn-primary { background: #22c55e; color: #0f172a; }
  .btn-danger { background: #ef4444; color: white; }
  .btn-secondary { background: #334155; color: #e2e8f0; }
  .btn-backend { background: #3b82f6; color: white; }
  .footer { margin-top: 16px; font-size: 12px; color: #475569; }
</style>
</head>
<body>
  <div class="card">
    <h1>${escapeH(title)}</h1>
    <p>${escapeH(description)}</p>
    <div class="code">Session: ${escapeH(sessionId)}</div>
    <div class="actions">
      <a class="btn btn-primary" href="/m/exec?action=${escapeH(action)}&sessionId=${escapeH(sessionId)}&callId=${escapeH(callId)}">✅ Confirm Approve</a>
      <a class="btn btn-danger" href="/m/exec?action=deny&sessionId=${escapeH(sessionId)}&callId=${escapeH(callId)}">❌ Deny</a>
      <a class="btn btn-secondary" href="/m/exec?action=escalate&sessionId=${escapeH(sessionId)}&callId=${escapeH(callId)}">↗ Escalate</a>
    </div>
    <div class="footer">los Agent Runtime Supervisor</div>
  </div>
</body>
</html>`;
}

// ── Helpers ────────────────────────────────────────────────────────

function escapeH(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function formatSize(bytes: number): string {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`;
}

export { DEFAULT_CAPABILITIES as WEIXIN_CAPABILITIES };
