/**
 * @los/wechat-bot/bridge/weclaw — WeClaw process manager and API client.
 *
 * Manages the WeClaw (fastclaw-ai/weclaw) Go binary lifecycle:
 *   - Install: curl-pipe install script
 *   - Start: spawn weclaw start as child process
 *   - Send: HTTP POST to weclaw's API (default 127.0.0.1:18011)
 *
 * WeClaw handles:
 *   - QR code WeChat login (iLink API)
 *   - Bidirectional messaging (text + image/video/file)
 *   - Multi-agent auto-detection (Claude, Codex, Gemini, etc.)
 *   - Voice message transcription
 *
 * los only needs to call the HTTP API for outbound messages.
 * Inbound messages are handled by WeClaw's own agent routing.
 * For handoff, los sends decision alerts to WeChat via /api/send.
 */

import { spawn, execSync, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { getLogger } from '@los/infra/logger';

const log = getLogger('weclaw-bridge');

export interface WeClawConfig {
  /** WeClaw binary path (default: auto-find) */
  binPath?: string;
  /** WeClaw API address (default: 127.0.0.1:18011) */
  apiAddr?: string;
  /** WeChat user ID to send messages to (default: from env) */
  defaultTo?: string;
  /** Working directory for weclaw config */
  configDir?: string;
  /** Whether to auto-install if not found */
  autoInstall?: boolean;
}

const DEFAULT_API_ADDR = '127.0.0.1:18011';
const DEFAULT_CONFIG_DIR = resolve(process.env.HOME ?? '/tmp', '.weclaw');

// ── Process management ─────────────────────────────────────────────

let weclawProc: ChildProcess | null = null;

export function isWeclawRunning(): boolean {
  return weclawProc !== null && !weclawProc.killed;
}

export function findWeclawBinary(): string | null {
  // 1. Explicit env
  if (process.env.WECLAW_BIN) return process.env.WECLAW_BIN;

  // 2. PATH lookup
  try {
    const path = execSync('which weclaw', { encoding: 'utf-8', timeout: 3000 }).trim();
    if (path && existsSync(path)) return path;
  } catch { /* not in PATH */ }

  // 3. Common install locations
  const candidates = [
    resolve(process.env.HOME ?? '/tmp', 'go/bin/weclaw'),
    '/usr/local/bin/weclaw',
    '/opt/homebrew/bin/weclaw',
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }

  return null;
}

export function installWeclaw(): { ok: boolean; path?: string; error?: string } {
  try {
    log.info('Installing WeClaw via install script...');
    execSync(
      'curl -sSL https://raw.githubusercontent.com/fastclaw-ai/weclaw/main/install.sh | sh',
      { stdio: 'inherit', timeout: 120_000 },
    );
    const bin = findWeclawBinary();
    if (bin) {
      log.info(`WeClaw installed: ${bin}`);
      return { ok: true, path: bin };
    }
    return { ok: false, error: 'installed but binary not found in PATH' };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

/**
 * Start WeClaw as a background daemon.
 * On first run, it prints a QR code to stdout for WeChat login.
 * We redirect stdout/stderr to a log file so the QR code is accessible.
 */
export function startWeclaw(config: WeClawConfig = {}): { ok: boolean; pid?: number; error?: string } {
  const binPath = config.binPath ?? findWeclawBinary();
  if (!binPath) {
    if (config.autoInstall !== false) {
      const installed = installWeclaw();
      if (!installed.ok) return { ok: false, error: `install failed: ${installed.error}` };
      return startWeclaw({ ...config, binPath: installed.path });
    }
    return { ok: false, error: 'weclaw not found. Install: curl -sSL https://raw.githubusercontent.com/fastclaw-ai/weclaw/main/install.sh | sh' };
  }

  try {
    const apiAddr = config.apiAddr ?? process.env.WECLAW_API_ADDR ?? DEFAULT_API_ADDR;
    const env = {
      ...process.env,
      WECLAW_API_ADDR: apiAddr,
      HOME: process.env.HOME,
    };

    // Run in foreground with output piped to log
    const logDir = resolve(config.configDir ?? DEFAULT_CONFIG_DIR);
    const proc = spawn(binPath, ['start'], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: false,
    });

    proc.stdout?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf-8');
      // Look for QR code URL in output
      if (text.includes('qrcode') || text.includes('QR') || text.includes('login')) {
        log.info(`[weclaw] ${text.trim()}`);
      }
    });

    proc.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf-8');
      log.info(`[weclaw] ${text.trim()}`);
    });

    proc.on('error', (err) => {
      log.error(`[weclaw] process error: ${err.message}`);
      weclawProc = null;
    });

    proc.on('close', (code) => {
      log.info(`[weclaw] exited with code ${code}`);
      weclawProc = null;
    });

    weclawProc = proc;
    log.info(`WeClaw started: pid=${proc.pid}, api=${apiAddr}`);

    return { ok: true, pid: proc.pid ?? undefined };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

export function stopWeclaw(): { ok: boolean; error?: string } {
  if (weclawProc && !weclawProc.killed) {
    weclawProc.kill('SIGTERM');
    weclawProc = null;
    return { ok: true };
  }

  // Fallback: use weclaw stop command
  try {
    const bin = findWeclawBinary();
    if (bin) {
      execSync(`${bin} stop`, { timeout: 10_000 });
      return { ok: true };
    }
  } catch { /* not running or not found */ }

  return { ok: true }; // Idempotent
}

// ── HTTP API client ─────────────────────────────────────────────────

export interface WeClawSendInput {
  to?: string;
  text?: string;
  mediaUrl?: string;
}

export interface WeClawSendResult {
  ok: boolean;
  messageId?: string;
  error?: string;
}

/**
 * Send a message to WeChat via WeClaw's HTTP API.
 */
export async function weclawSend(input: WeClawSendInput, config: WeClawConfig = {}): Promise<WeClawSendResult> {
  const addr = config.apiAddr ?? process.env.WECLAW_API_ADDR ?? DEFAULT_API_ADDR;
  const to = input.to ?? config.defaultTo ?? process.env.WECLAW_DEFAULT_TO;
  if (!to) {
    return { ok: false, error: 'no recipient: set WECLAW_DEFAULT_TO or pass "to" param' };
  }

  try {
    const body: Record<string, unknown> = { to };
    if (input.text) body.text = input.text;
    if (input.mediaUrl) body.media_url = input.mediaUrl;

    const res = await fetch(`http://${addr}/api/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      return { ok: false, error: `weclaw API ${res.status}: ${errText.slice(0, 200)}` };
    }

    const data = await res.json() as Record<string, unknown>;
    return { ok: true, messageId: (data?.message_id as string) ?? undefined };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

/**
 * Check if WeClaw API is healthy.
 */
export async function weclawHealth(config: WeClawConfig = {}): Promise<boolean> {
  const addr = config.apiAddr ?? process.env.WECLAW_API_ADDR ?? DEFAULT_API_ADDR;
  try {
    const res = await fetch(`http://${addr}/health`, { signal: AbortSignal.timeout(3000) });
    return res.ok;
  } catch {
    return false;
  }
}
