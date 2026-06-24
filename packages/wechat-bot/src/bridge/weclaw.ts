/**
 * @los/wechat-bot/bridge/weclaw — WeClaw process manager and API client.
 *
 * Manages the WeClaw (fastclaw-ai/weclaw) Go binary lifecycle:
 *   - Install: hash-verified install script (NEVER curl-pipe-to-shell blind)
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
import { createHash } from 'node:crypto';
import { existsSync, writeFileSync, unlinkSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
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
let weclawWasStartedByUs = false;

export function isWeclawRunning(): boolean {
  // 1. Check our own managed child process
  if (weclawProc !== null && !weclawProc.killed) return true;

  // 2. Check OS process table for any weclaw process
  try {
    const out = execSync('pgrep -l weclaw 2>/dev/null || true', { encoding: 'utf-8', timeout: 2000 }).trim();
    if (out) return true;
  } catch { /* pgrep not available, fall through */ }

  return false;
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

export const WECLAW_INSTALL_URL_DEFAULT = 'https://raw.githubusercontent.com/fastclaw-ai/weclaw/main/install.sh';

/** Compute the sha256 hex digest of an install script's content. */
export function hashInstallScript(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

/**
 * Verify a downloaded install script against an expected sha256. Returns an
 * error string explaining why verification failed, or null when it passes.
 *
 * Auto-install is refused unless the operator has pinned the expected hash via
 * WECLAW_INSTALL_SHA256. This prevents silent supply-chain replacement of the
 * remote install script (the previous behavior executed `curl ... | sh` with no
 * verification).
 */
export function verifyInstallScript(content: string, expectedHash: string | undefined): string | null {
  if (!expectedHash) {
    return 'WECLAW_INSTALL_SHA256 is not set; refusing to auto-install an unpinned install script (supply-chain risk). Pin the hash or install WeClaw manually.';
  }
  const actual = hashInstallScript(content);
  if (actual !== expectedHash) {
    return `install script sha256 mismatch: expected ${expectedHash}, got ${actual}. Refusing to execute a modified script.`;
  }
  return null;
}

export function installWeclaw(): { ok: boolean; path?: string; error?: string } {
  const url = process.env.WECLAW_INSTALL_URL ?? WECLAW_INSTALL_URL_DEFAULT;
  if (!/^https:\/\//.test(url)) {
    return { ok: false, error: `WECLAW_INSTALL_URL must be an https URL (got: ${url})` };
  }
  const expectedHash = process.env.WECLAW_INSTALL_SHA256;
  try {
    log.info('Downloading WeClaw install script for hash verification...', { url });
    // Download to memory — never pipe a remote script straight into sh.
    const script = execSync(`curl -fsSL ${JSON.stringify(url)}`, {
      encoding: 'utf-8',
      timeout: 60_000,
      maxBuffer: 10 * 1024 * 1024,
    });
    const verifyError = verifyInstallScript(script, expectedHash);
    if (verifyError) {
      log.error(verifyError);
      return { ok: false, error: verifyError };
    }
    log.info('Install script hash verified; executing from temp file.');

    // Execute the verified script from a local temp file (not a remote pipe).
    const dir = mkdtempSync(join(tmpdir(), 'weclaw-install-'));
    const scriptPath = join(dir, 'install.sh');
    writeFileSync(scriptPath, script, { mode: 0o700 });
    try {
      execSync(`sh ${JSON.stringify(scriptPath)}`, { stdio: 'inherit', timeout: 120_000 });
    } finally {
      try { unlinkSync(scriptPath); } catch { /* best-effort cleanup */ }
    }
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
    return { ok: false, error: 'weclaw not found. Install manually, or set WECLAW_AUTO_INSTALL=1 and WECLAW_INSTALL_SHA256=<sha256 of install.sh> to enable hash-verified auto-install.' };
  }

  // Don't spawn a duplicate if weclaw is already running at OS level
  if (isWeclawRunning()) {
    log.info('WeClaw already running — skip start');
    return { ok: true, pid: 0 }; // pid 0 = already running externally
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
      weclawWasStartedByUs = false;
    });

    weclawProc = proc;
    weclawWasStartedByUs = true;
    log.info(`WeClaw started: pid=${proc.pid}, api=${apiAddr}`);

    return { ok: true, pid: proc.pid ?? undefined };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

export function stopWeclaw(): { ok: boolean; error?: string } {
  if (weclawProc && !weclawProc.killed && weclawWasStartedByUs) {
    weclawProc.kill('SIGTERM');
    weclawProc = null;
    weclawWasStartedByUs = false;
    return { ok: true };
  }

  // If we didn't start it, don't stop it — another process may be using it
  if (!weclawWasStartedByUs) {
    return { ok: true }; // Idempotent — not ours to stop
  }

  // Fallback: use weclaw stop command (only if we started it)
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
