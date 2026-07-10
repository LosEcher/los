/**
 * Communication Accounts — Channel binding and device management routes.
 *
 * GET  /communication/accounts          — list bound accounts
 * POST /communication/accounts/weclaw/qr/start — QR login session
 * GET  /communication/accounts/weclaw/qr/:id — session status
 * GET  /communication/accounts/weclaw/status — runtime status
 * POST /communication/accounts/weclaw/send — send message
 */

import type { FastifyInstance } from 'fastify';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { requireOperator } from '../../request-context.js';

interface WeixinAccount {
  accountId: string;
  userId?: string;
  hasToken: boolean;
  hasSyncState: boolean;
  savedAt?: string;
  source: string;
  aliases?: string[];
}

interface WeixinLoginSession {
  sessionId: string;
  status: 'idle' | 'starting' | 'waiting_scan' | 'logged_in' | 'failed' | 'expired';
  qrUrl?: string;
  qrData?: string;
  statusPath?: string;
  pid?: number;
  lastReason?: string;
  runtimeActive: boolean;
}

const loginSessions = new Map<string, WeixinLoginSession>();

function findWeclawBinary(): string | null {
  for (const p of [
    process.env.WECLAW_BIN,
    resolve(process.env.HOME ?? '/tmp', 'go/bin/weclaw'),
    '/usr/local/bin/weclaw',
    '/opt/homebrew/bin/weclaw',
  ]) {
    if (p && existsSync(p)) return p;
  }
  try {
    const cp = require('node:child_process') as typeof import('node:child_process');
    return cp.execSync('which weclaw', { encoding: 'utf-8', timeout: 3000 }).trim() || null;
  } catch {
    return null;
  }
}

function getDefaultTo(): string {
  const envTo = process.env.WECLAW_DEFAULT_TO;
  if (envTo) return envTo;

  const accounts = buildWeixinAccounts();
  for (const acc of accounts) {
    if (acc.userId && acc.userId.includes('@im.wechat') && acc.hasToken) return acc.userId;
  }
  return '';
}

function buildWeixinAccounts(): WeixinAccount[] {
  const configDir = resolve(process.env.HOME ?? '/tmp', '.weclaw', 'accounts');
  if (!existsSync(configDir)) return [];

  try {
    const accounts: WeixinAccount[] = [];
    const files = readdirSync(configDir).filter(f => f.endsWith('.json') && !f.endsWith('.sync.json'));
    for (const file of files) {
      try {
        const data = JSON.parse(readFileSync(resolve(configDir, file), 'utf-8'));
        const accountId = (data?.ilink_bot_id ?? data?.bot_id ?? file.replace('.json', '')) as string;
        const userId = (data?.ilink_user_id ?? data?.user_id ?? '') as string || undefined;
        accounts.push({
          accountId,
          userId,
          hasToken: Boolean(data?.bot_token),
          hasSyncState: true,
          savedAt: new Date().toISOString(),
          source: 'weclaw',
        });
      } catch { /* skip malformed */ }
    }
    return accounts;
  } catch {
    return [];
  }
}

export function registerCommunicationRoutes(app: FastifyInstance): void {
  app.get('/communication/accounts', async () => {
    const weclaw = findWeclawBinary();
    const accounts = buildWeixinAccounts();
    return {
      channels: [
        { id: 'weixin', label: 'WeChat', status: accounts.length > 0 ? 'connected' : 'needs_binding', description: 'WeClaw bridge for bidirectional WeChat', accountCount: accounts.length, live: true },
        { id: 'telegram', label: 'Telegram', status: 'planned', description: 'Coming soon', accountCount: 0, live: false },
        { id: 'feishu', label: 'FlyBook', status: 'planned', description: 'Coming soon', accountCount: 0, live: false },
        { id: 'web', label: 'Web Dashboard', status: 'live', description: 'Mobile web console', accountCount: 0, live: true },
      ],
      weixin: { accounts, weclawInstalled: Boolean(weclaw), weclawBinary: weclaw ?? null },
    };
  });

  app.post('/communication/accounts/weclaw/qr/start', async (req, reply) => {
    if (!(await requireOperator(req, reply))) return;
    const weclaw = findWeclawBinary();
    if (!weclaw) {
      return reply.status(400).send({ ok: false, error: 'weclaw_not_installed' });
    }

    const sessionId = randomUUID();
    const session: WeixinLoginSession = { sessionId, status: 'starting', statusPath: '', runtimeActive: true };
    loginSessions.set(sessionId, session);

    try {
      const proc = spawn(weclaw, ['login'], { env: { ...process.env, HOME: process.env.HOME }, stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      proc.stdout?.on('data', (c: Buffer) => {
        out += c.toString('utf-8');
        const m = out.match(/https:\/\/liteapp\.weixin\.qq\.com\/[^\s]+/);
        if (m && !session.qrUrl) { session.qrUrl = m[0]; session.status = 'waiting_scan'; }
      });
      proc.stderr?.on('data', (c: Buffer) => { out += c.toString('utf-8'); });
      proc.on('close', (code) => {
        session.status = code === 0 ? 'logged_in' : (session.status === 'waiting_scan' ? 'expired' : 'failed');
        session.lastReason = code === 0 ? 'Login successful' : `Exit code ${code}`;
        session.runtimeActive = false;
      });
      proc.on('error', (err) => { session.status = 'failed'; session.lastReason = err.message; session.runtimeActive = false; });
      session.pid = proc.pid ?? undefined;
      await new Promise(r => setTimeout(r, 3000));
      session.qrUrl = session.qrUrl || undefined;
      session.statusPath = out.slice(-1000);
      return reply.send({ ok: true, session });
    } catch (err) {
      session.status = 'failed'; session.lastReason = (err as Error).message; session.runtimeActive = false;
      return reply.status(500).send({ ok: false, error: 'qr_session_failed', session });
    }
  });

  app.get('/communication/accounts/weclaw/qr/:sessionId', async (req, reply) => {
    const s = loginSessions.get((req.params as { sessionId: string }).sessionId);
    if (!s) return reply.status(404).send({ ok: false, error: 'session_not_found' });
    return reply.send({ ok: true, session: s });
  });

  app.get('/communication/accounts/weclaw/status', async () => {
    const weclaw = findWeclawBinary();
    const accounts = buildWeixinAccounts();
    let daemonRunning = false;
    try { const r = await fetch('http://127.0.0.1:18011/health', { signal: AbortSignal.timeout(2000) }); daemonRunning = r.ok; } catch { /* */ }
    return {
      installed: Boolean(weclaw), binary: weclaw ?? null, accounts, accountCount: accounts.length,
      configExists: existsSync(resolve(process.env.HOME ?? '/tmp', '.weclaw', 'config.json')),
      daemonRunning, defaultTo: getDefaultTo(),
    };
  });

  app.post('/communication/accounts/weclaw/send', async (req, reply) => {
    if (!(await requireOperator(req, reply))) return;
    const body = req.body as Record<string, unknown> | undefined;
    const to = (body?.to as string) || getDefaultTo() || process.env.WECLAW_DEFAULT_TO;
    const text = (body?.text as string) ?? '';
    const mediaUrl = (body?.media_url as string) ?? (body?.mediaUrl as string) ?? null;
    if (!to) return reply.status(400).send({ ok: false, error: 'recipient (to) required' });
    try {
      const sendBody: Record<string, unknown> = { to };
      if (text) sendBody.text = text;
      if (mediaUrl) sendBody.media_url = mediaUrl;
      const res = await fetch('http://127.0.0.1:18011/api/send', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(sendBody), signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) { const et = await res.text().catch(() => ''); return reply.status(502).send({ ok: false, error: `API ${res.status}: ${et.slice(0, 200)}` }); }
      const data = await res.json() as Record<string, unknown>;
      return reply.send({ ok: true, messageId: data?.message_id });
    } catch (err) { return reply.status(502).send({ ok: false, error: (err as Error).message }); }
  });
}
