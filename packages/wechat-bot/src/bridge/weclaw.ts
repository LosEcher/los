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

const WECLAW_SEND_MAX_ATTEMPTS = 3;
/** Consecutive send failures after which HTTP /health is treated as delivery-degraded. */
const WECLAW_SEND_DEGRADED_AFTER = 2;

export interface WeClawSendHealth {
  consecutiveFailures: number;
  lastError: string | null;
  lastOkAt: string | null;
  lastFailedAt: string | null;
  /** False when recent sends failed even if /health still returns ok. */
  sendHealthy: boolean;
}

let sendHealth: WeClawSendHealth = {
  consecutiveFailures: 0,
  lastError: null,
  lastOkAt: null,
  lastFailedAt: null,
  sendHealthy: true,
};

function noteWeclawSendSuccess(): void {
  sendHealth = {
    consecutiveFailures: 0,
    lastError: null,
    lastOkAt: new Date().toISOString(),
    lastFailedAt: sendHealth.lastFailedAt,
    sendHealthy: true,
  };
}

function noteWeclawSendFailure(error: string): void {
  const consecutiveFailures = sendHealth.consecutiveFailures + 1;
  sendHealth = {
    consecutiveFailures,
    lastError: error.slice(0, 300),
    lastOkAt: sendHealth.lastOkAt,
    lastFailedAt: new Date().toISOString(),
    sendHealthy: consecutiveFailures < WECLAW_SEND_DEGRADED_AFTER,
  };
}

/** Recent outbound send health (process-local; resets on bot restart). */
export function getWeclawSendHealth(): WeClawSendHealth {
  return { ...sendHealth };
}

/** Test helper — reset send counters without a live send. */
export function resetWeclawSendHealthForTests(): void {
  sendHealth = {
    consecutiveFailures: 0,
    lastError: null,
    lastOkAt: null,
    lastFailedAt: null,
    sendHealthy: true,
  };
}

function isRetryableWeclawSendError(message: string): boolean {
  return /prepare failed|ret=-2|EOF|timeout|ECONNRESET|ECONNREFUSED|fetch failed|503|502|504/i
    .test(message);
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Split long operator text into WeChat-safe chunks.
 * iLink prepare/send is flaky on multi-KB bodies under degraded sessions.
 */
export function splitWeclawText(text: string, maxChars = 1800): string[] {
  const normalized = text.replace(/\r\n/g, '\n').trim();
  if (!normalized) return [];
  if (normalized.length <= maxChars) return [normalized];

  const chunks: string[] = [];
  let remaining = normalized;
  while (remaining.length > maxChars) {
    let cut = remaining.lastIndexOf('\n', maxChars);
    if (cut < Math.floor(maxChars * 0.4)) cut = maxChars;
    chunks.push(remaining.slice(0, cut).trimEnd());
    remaining = remaining.slice(cut).replace(/^\n+/, '');
  }
  if (remaining.trim()) chunks.push(remaining.trim());
  return chunks;
}

/**
 * Send a message to WeChat via WeClaw's HTTP API.
 * Retries transient iLink failures (prepare failed / EOF) with short backoff.
 * Long text is split into sequential chunks so a single oversized body does not
 * take down the whole digest push.
 */
export async function weclawSend(input: WeClawSendInput, config: WeClawConfig = {}): Promise<WeClawSendResult> {
  const addr = config.apiAddr ?? process.env.WECLAW_API_ADDR ?? DEFAULT_API_ADDR;
  const to = input.to ?? config.defaultTo ?? process.env.WECLAW_DEFAULT_TO;
  if (!to) {
    const error = 'no recipient: set WECLAW_DEFAULT_TO or pass "to" param';
    noteWeclawSendFailure(error);
    return { ok: false, error };
  }

  if (input.mediaUrl && !input.text) {
    return weclawSendOnce({ to, media_url: input.mediaUrl }, addr);
  }

  const parts = input.text ? splitWeclawText(input.text) : [''];
  let lastMessageId: string | undefined;
  for (let i = 0; i < parts.length; i += 1) {
    const body: Record<string, unknown> = { to, text: parts[i] };
    // Attach media only on the first chunk so multi-part digests stay text-only after.
    if (i === 0 && input.mediaUrl) body.media_url = input.mediaUrl;
    const result = await weclawSendOnce(body, addr);
    if (!result.ok) return result;
    lastMessageId = result.messageId ?? lastMessageId;
    if (i + 1 < parts.length) await sleep(400);
  }
  return { ok: true, messageId: lastMessageId };
}

async function weclawSendOnce(
  body: Record<string, unknown>,
  addr: string,
): Promise<WeClawSendResult> {
  let lastError = 'weclaw send failed';
  for (let attempt = 1; attempt <= WECLAW_SEND_MAX_ATTEMPTS; attempt += 1) {
    try {
      const res = await fetch(`http://${addr}/api/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      });

      if (!res.ok) {
        const errText = await res.text().catch(() => '');
        lastError = `weclaw API ${res.status}: ${errText.slice(0, 200)}`;
        if (attempt < WECLAW_SEND_MAX_ATTEMPTS && isRetryableWeclawSendError(lastError)) {
          log.warn(`weclaw send retry ${attempt}/${WECLAW_SEND_MAX_ATTEMPTS}: ${lastError}`);
          await sleep(attempt * 1500);
          continue;
        }
        noteWeclawSendFailure(lastError);
        return { ok: false, error: lastError };
      }

      const data = await res.json() as Record<string, unknown>;
      noteWeclawSendSuccess();
      return { ok: true, messageId: (data?.message_id as string) ?? undefined };
    } catch (err) {
      lastError = (err as Error).message;
      if (attempt < WECLAW_SEND_MAX_ATTEMPTS && isRetryableWeclawSendError(lastError)) {
        log.warn(`weclaw send retry ${attempt}/${WECLAW_SEND_MAX_ATTEMPTS}: ${lastError}`);
        await sleep(attempt * 1500);
        continue;
      }
      noteWeclawSendFailure(lastError);
      return { ok: false, error: lastError };
    }
  }
  noteWeclawSendFailure(lastError);
  return { ok: false, error: lastError };
}

/**
 * Check if WeClaw API is healthy.
 * HTTP liveness alone is not delivery readiness — combine with getWeclawSendHealth().
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
