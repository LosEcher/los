/**
 * Optional session pin for WeChat companion mode.
 * When bound, only that session (+ global ops/governance) is pushed.
 *
 * Override with env LOS_CHANNEL_BOUND_SESSION_ID, or set via #bind-session.
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

const DEFAULT_PATH = join(
  process.env.LOS_RUNTIME_DIR ?? join(process.cwd(), '.los-runtime'),
  'wechat-bound-session.json',
);

export type BoundSessionState = {
  sessionId: string;
  boundAt: string;
  source: 'env' | 'command' | 'file';
};

export function resolveBoundSessionPath(custom?: string): string {
  return custom ?? process.env.LOS_CHANNEL_BIND_FILE ?? DEFAULT_PATH;
}

export function loadBoundSession(path = resolveBoundSessionPath()): BoundSessionState | null {
  const fromEnv = process.env.LOS_CHANNEL_BOUND_SESSION_ID?.trim();
  if (fromEnv) {
    return { sessionId: fromEnv, boundAt: new Date(0).toISOString(), source: 'env' };
  }
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as { sessionId?: string; boundAt?: string };
    if (!raw.sessionId?.trim()) return null;
    return {
      sessionId: raw.sessionId.trim(),
      boundAt: raw.boundAt ?? new Date(0).toISOString(),
      source: 'file',
    };
  } catch {
    return null;
  }
}

export function saveBoundSession(sessionId: string, path = resolveBoundSessionPath()): BoundSessionState {
  const state: BoundSessionState = {
    sessionId: sessionId.trim(),
    boundAt: new Date().toISOString(),
    source: 'command',
  };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  return state;
}

export function clearBoundSession(path = resolveBoundSessionPath()): void {
  if (existsSync(path)) writeFileSync(path, '{}\n', 'utf8');
}
