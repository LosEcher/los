/**
 * @los/wechat-bot/channel/web — Mobile web channel.
 *
 * Provides a minimal mobile-optimized web dashboard for agent handoff.
 * Serves:
 *   /m/          — mobile operator dashboard
 *   /m/action    — action confirmation page
 *   /m/sessions  — session status view
 *
 * This enables handoff even when the operator doesn't use WeChat/Telegram —
 * they can access the mobile web dashboard from any browser.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type {
  Channel,
  ChannelCapabilities,
  ChannelKind,
  ChannelSendResult,
  UnifiedMessage,
} from './types.js';

export interface WebChannelConfig {
  kind: 'web';
  port: number;
  host?: string;
  losGatewayUrl: string;
  losAuthToken?: string;
  losOperatorToken?: string;
}

const WEB_CAPABILITIES: ChannelCapabilities = {
  text: true,
  image: true,
  video: true,
  file: true,
  actions: true,
  richText: true,
  upCall: false,
  mobileWeb: true,
  maxTextLength: 100000,
  maxMediaSize: 50 * 1024 * 1024, // 50MB
};

export function createWebChannel(config: WebChannelConfig): Channel {
  const { port, host = '127.0.0.1', losGatewayUrl, losAuthToken, losOperatorToken } = config;
  const messageHandlers = new Set<(msg: UnifiedMessage) => void | Promise<void>>();
  let server: ReturnType<typeof createServer> | null = null;

  // In-memory event store for mobile dashboard
  const events: Array<{ id: string; ts: string; text: string; sessionId: string; severity: string }> = [];
  const MAX_EVENTS = 200;

  const channel: Channel = {
    kind: 'web' as ChannelKind,
    capabilities: WEB_CAPABILITIES,

    async start() {
      server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
        const url = new URL(req.url ?? '/', `http://${host}:${port}`);

        // ── Mobile dashboard ────────────────────────────
        if (req.method === 'GET' && (url.pathname === '/m/' || url.pathname === '/m' || url.pathname === '/')) {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(renderMobileDashboard(events, losGatewayUrl));
          return;
        }

        // ── Action execution ────────────────────────────
        if (req.method === 'GET' && url.pathname === '/m/exec') {
          const action = url.searchParams.get('action') ?? '';
          const sessionId = url.searchParams.get('sessionId') ?? '';
          const callId = url.searchParams.get('callId') ?? '';

          let result = 'Unknown action';
          try {
            switch (action) {
              case 'approve':
                await fetch(`${losGatewayUrl}/sessions/${sessionId}/operator-events`, {
                  method: 'POST', headers: losHeaders(losAuthToken, losOperatorToken),
                  body: JSON.stringify({ type: 'steering', instruction: 'Approved via mobile web', turnBoundary: 'immediate', actor: 'mobile-web', reason: 'operator_approval' }),
                });
                result = '✅ Approved';
                break;
              case 'deny':
                await fetch(`${losGatewayUrl}/sessions/${sessionId}/operator-events`, {
                  method: 'POST', headers: losHeaders(losAuthToken, losOperatorToken),
                  body: JSON.stringify({ type: 'steering', instruction: 'Denied via mobile web', turnBoundary: 'immediate', actor: 'mobile-web', reason: 'operator_denial' }),
                });
                result = '❌ Denied';
                break;
              case 'escalate':
                await fetch(`${losGatewayUrl}/sessions/${sessionId}/operator-events`, {
                  method: 'POST', headers: losHeaders(losAuthToken, losOperatorToken),
                  body: JSON.stringify({ type: 'steering', instruction: 'Escalated via mobile web', turnBoundary: 'immediate', actor: 'mobile-web', reason: 'operator_escalation' }),
                });
                result = '↗ Escalated';
                break;
            }
          } catch (err) {
            result = `Error: ${(err as Error).message}`;
          }

          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(renderActionResult(result, sessionId));
          return;
        }

        // ── Session list API ────────────────────────────
        if (req.method === 'GET' && url.pathname === '/m/api/events') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ events: events.slice(-50) }));
          return;
        }

        res.writeHead(404);
        res.end('Not found');
      });

      await new Promise<void>((resolve) => server!.listen(port, host, resolve));
      console.log(`[web-channel] Mobile dashboard on http://${host}:${port}/m/`);
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
      // Store in-memory for mobile dashboard display
      events.push({
        id: message.id,
        ts: message.metadata.timestamp,
        text: message.text,
        sessionId: message.metadata.sessionId ?? '',
        severity: message.routing.priority,
      });
      if (events.length > MAX_EVENTS) events.shift();

      // The web channel is pull-based (mobile browser refreshes the page)
      return { ok: true, messageId: message.id, channel: 'web' };
    },

    async sendCard(message: UnifiedMessage): Promise<ChannelSendResult> {
      return channel.send(message);
    },

    onMessage(handler) {
      messageHandlers.add(handler);
      return () => { messageHandlers.delete(handler); };
    },

    async health() {
      return { healthy: true, message: `mobile web on port ${port}` };
    },
  };

  return channel;
}

// ── Mobile dashboard HTML ──────────────────────────────────────────

function renderMobileDashboard(
  evts: Array<{ id: string; ts: string; text: string; sessionId: string; severity: string }>,
  gatewayUrl: string,
): string {
  const eventRows = evts.slice(-30).reverse().map(e => {
    const icon = e.severity === 'CRITICAL' ? '🔴' : e.severity === 'HIGH' ? '⚠️' : 'ℹ️';
    const time = new Date(e.ts).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
    const sid = e.sessionId.slice(0, 8);
    const text = e.text.slice(0, 120);
    return `<div class="event" style="padding:12px;border-bottom:1px solid #1e293b;">
  <div style="display:flex;justify-content:space-between;align-items:center;">
    <span>${icon} <strong>${escapeH(text)}</strong></span>
    <span style="font-size:12px;color:#64748b;">${time}</span>
  </div>
  <div style="font-size:12px;color:#475569;margin-top:4px;">${sid}</div>
</div>`;
  }).join('');

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="mobile-web-app-capable" content="yes">
<meta name="theme-color" content="#0f172a">
<title>los Agent</title>
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
         background: #0f172a; color: #e2e8f0; min-height: 100vh; }
  .header { background: #1e293b; padding: 16px 20px; position: sticky; top: 0;
            border-bottom: 1px solid #334155; display: flex; justify-content: space-between; align-items: center; }
  .header h2 { font-size: 18px; }
  .header .badge { background: #22c55e; color: #0f172a; border-radius: 999px;
                  padding: 2px 10px; font-size: 12px; font-weight: 600; }
  .stats { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 12px; padding: 16px 20px; }
  .stat { background: #1e293b; border-radius: 12px; padding: 16px; text-align: center; }
  .stat .num { font-size: 24px; font-weight: 700; }
  .stat .label { font-size: 11px; color: #64748b; margin-top: 4px; text-transform: uppercase; letter-spacing: 0.5px; }
  .events { padding: 0 0 80px; }
  .event:active { background: #1e293b; }
  .refresh { background: none; border: none; color: #3b82f6; font-size: 20px; cursor: pointer; }
  .tabs { position: fixed; bottom: 0; width:100%; background: #1e293b; border-top: 1px solid #334155;
         display: grid; grid-template-columns: 1fr 1fr 1fr; }
  .tab { padding: 12px; text-align: center; color: #64748b; font-size: 11px;
         text-decoration: none; border-top: 2px solid transparent; }
  .tab.active { color: #3b82f6; border-top-color: #3b82f6; }
</style>
</head>
<body>
  <div class="header">
    <h2>⚡ los Agent</h2>
    <button class="refresh" onclick="location.reload()">↻</button>
  </div>

  <div class="stats">
    <div class="stat"><div class="num">${evts.length}</div><div class="label">Events</div></div>
    <div class="stat"><div class="num" style="color:#3b82f6;">${gatewayUrl.includes('localhost') ? 'LOCAL' : 'LIVE'}</div><div class="label">GW</div></div>
    <div class="stat"><div class="num">${evts.filter(e => e.severity === 'CRITICAL').length}</div><div class="label">Critical</div></div>
  </div>

  <div class="events">${eventRows || '<div style="padding:24px;text-align:center;color:#475569;">Waiting for events...</div>'}</div>

  <div class="tabs">
    <a class="tab active" href="/m/">Events</a>
    <a class="tab" href="${gatewayUrl}/tasks">Tasks</a>
    <a class="tab" href="${gatewayUrl}/sessions">Sessions</a>
  </div>
  <script>
    // Auto-refresh every 10s
    setInterval(() => location.reload(), 10000);
  </script>
</body>
</html>`;
}

function renderActionResult(result: string, sessionId: string): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Result</title>
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
         background: #0f172a; color: #e2e8f0; min-height: 100vh;
         display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 24px; }
  .card { background: #1e293b; border-radius: 16px; padding: 32px 24px;
          max-width: 360px; width: 100%; text-align: center; }
  h1 { font-size: 24px; margin-bottom: 16px; }
  a { color: #3b82f6; text-decoration: none; }
</style>
</head>
<body>
  <div class="card">
    <h1>${escapeH(result)}</h1>
    <p style="font-size:12px;color:#475569;">${escapeH(sessionId.slice(0, 16))}...</p>
    <p style="margin-top:24px;"><a href="/m/">← Back to Dashboard</a></p>
  </div>
</body>
</html>`;
}

function escapeH(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function losHeaders(authToken: string | undefined, operatorToken?: string): Record<string, string> {
  const h: Record<string, string> = { 'Content-Type': 'application/json' };
  if (authToken) h['x-los-auth-token'] = authToken;
  if (operatorToken) h['x-los-operator-token'] = operatorToken;
  return h;
}
