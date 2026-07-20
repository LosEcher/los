import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { XaiOAuthError, type XaiOAuthState } from './xai-oauth-types.js';

const PROVIDER_KEY = 'xai-oauth';
const DEFAULT_LOCK_TIMEOUT_MS = 10_000;
const DEFAULT_LOCK_RETRY_MS = 25;
const DEFAULT_STALE_LOCK_MS = 120_000;

export interface _XaiOAuthStoreOptions {
  authPath?: string;
  hermesPath?: string;
  lockTimeoutMs?: number;
  lockRetryMs?: number;
  staleLockMs?: number;
}

export interface _XaiOAuthSaveOptions {
  expectedGeneration?: number;
}

export interface _LoadedXaiOAuthState {
  state: XaiOAuthState;
  source: 'los-auth-store' | 'hermes-auth-store';
}

export class _XaiOAuthStore {
  readonly authPath: string;
  readonly hermesPath: string;
  readonly lockPath: string;
  private readonly lockTimeoutMs: number;
  private readonly lockRetryMs: number;
  private readonly staleLockMs: number;

  constructor(options: _XaiOAuthStoreOptions = {}) {
    this.authPath = options.authPath ?? join(homedir(), '.los', 'auth.json');
    this.hermesPath = options.hermesPath ?? join(homedir(), '.hermes', 'auth.json');
    this.lockPath = `${this.authPath}.lock`;
    this.lockTimeoutMs = options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
    this.lockRetryMs = options.lockRetryMs ?? DEFAULT_LOCK_RETRY_MS;
    this.staleLockMs = options.staleLockMs ?? DEFAULT_STALE_LOCK_MS;
  }

  load(): XaiOAuthState | null {
    return this.loadWithSource()?.state ?? null;
  }

  loadWithSource(): _LoadedXaiOAuthState | null {
    if (existsSync(this.authPath)) {
      const state = readProviderState(readLosStore(this.authPath), this.authPath);
      if (state) return { state, source: 'los-auth-store' };
    }

    try {
      if (!existsSync(this.hermesPath)) return null;
      const state = readProviderState(readStore(this.hermesPath), this.hermesPath);
      return state ? { state, source: 'hermes-auth-store' } : null;
    } catch {
      // Hermes is an external fallback. Its malformed state must not be copied
      // into LOS, but it also must not make an otherwise empty LOS store fatal.
      return null;
    }
  }

  generation(state: XaiOAuthState | null | undefined): number {
    const value = state?.credential_generation;
    return Number.isSafeInteger(value) && (value ?? 0) >= 0 ? value! : 0;
  }

  async save(state: XaiOAuthState, options: _XaiOAuthSaveOptions = {}): Promise<XaiOAuthState> {
    return this.withCredentialLock(() => this._saveWhileLocked(state, options));
  }

  _saveWhileLocked(state: XaiOAuthState, options: _XaiOAuthSaveOptions = {}): XaiOAuthState {
    const store = existsSync(this.authPath) ? readLosStore(this.authPath) : {};
    const providers = readProviders(store, this.authPath);
    const current = readProviderState(store, this.authPath);
    const currentGeneration = this.generation(current);
    if (
      options.expectedGeneration !== undefined
      && options.expectedGeneration !== currentGeneration
    ) {
      throw new XaiOAuthError(
        `xAI credential generation changed from ${options.expectedGeneration} to ${currentGeneration}`,
        'xai_credential_generation_conflict',
      );
    }

    const next: XaiOAuthState = {
      ...state,
      credential_generation: currentGeneration + 1,
    };
    providers[PROVIDER_KEY] = next;
    store.providers = providers;
    writeStoreAtomically(this.authPath, store);
    return next;
  }

  async clear(options: _XaiOAuthSaveOptions = {}): Promise<boolean> {
    return this.withCredentialLock(() => this._clearWhileLocked(options));
  }

  _clearWhileLocked(options: _XaiOAuthSaveOptions = {}): boolean {
    if (!existsSync(this.authPath)) return false;
    const store = readLosStore(this.authPath);
    const providers = readProviders(store, this.authPath);
    const current = readProviderState(store, this.authPath);
    if (!current) return false;
    if (
      options.expectedGeneration !== undefined
      && options.expectedGeneration !== this.generation(current)
    ) {
      return false;
    }

    delete providers[PROVIDER_KEY];
    store.providers = providers;
    writeStoreAtomically(this.authPath, store);
    return true;
  }

  async withCredentialLock<T>(action: () => Promise<T> | T): Promise<T> {
    ensurePrivateDirectory(dirname(this.authPath));
    const startedAt = Date.now();
    const lockId = randomUUID();
    let fd: number | undefined;

    while (fd === undefined) {
      try {
        const candidate = openSync(this.lockPath, 'wx', 0o600);
        try {
          writeFileSync(candidate, JSON.stringify({ lockId, pid: process.pid, createdAt: new Date().toISOString() }));
          fd = candidate;
        } catch (error) {
          closeSync(candidate);
          rmSync(this.lockPath, { force: true });
          throw error;
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        this.removeStaleLock();
        if (Date.now() - startedAt >= this.lockTimeoutMs) {
          throw new XaiOAuthError(
            `Timed out waiting for xAI credential lock ${this.lockPath}`,
            'xai_refresh_lock_timeout',
          );
        }
        await delay(this.lockRetryMs);
      }
    }

    try {
      return await action();
    } finally {
      closeSync(fd);
      if (readLockId(this.lockPath) === lockId) {
        rmSync(this.lockPath, { force: true });
      }
    }
  }

  private removeStaleLock(): void {
    try {
      if (Date.now() - statSync(this.lockPath).mtimeMs > this.staleLockMs) {
        rmSync(this.lockPath, { force: true });
      }
    } catch {
      // Another process released or replaced the lock. Retry acquisition.
    }
  }
}

export const _xaiOAuthStore = new _XaiOAuthStore();

function readLosStore(path: string): Record<string, unknown> {
  ensurePrivateDirectory(dirname(path));
  if (process.platform !== 'win32') chmodSync(path, 0o600);
  return readStore(path);
}

function readStore(path: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf-8'));
  } catch (error) {
    throw malformedStoreError(path, error);
  }
  if (!isRecord(parsed)) throw malformedStoreError(path);
  return parsed;
}

function readProviders(store: Record<string, unknown>, path: string): Record<string, unknown> {
  const providers = store.providers;
  if (providers === undefined) return {};
  if (!isRecord(providers)) throw malformedStoreError(path);
  return { ...providers };
}

function readProviderState(store: Record<string, unknown>, path: string): XaiOAuthState | null {
  const providers = readProviders(store, path);
  const state = providers[PROVIDER_KEY];
  if (state === undefined) return null;
  if (!isRecord(state) || !isRecord(state.tokens) || typeof state.tokens.access_token !== 'string') {
    throw malformedStoreError(path);
  }
  return state as unknown as XaiOAuthState;
}

function writeStoreAtomically(path: string, store: Record<string, unknown>): void {
  const dir = dirname(path);
  ensurePrivateDirectory(dir);
  const tempPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(tempPath, `${JSON.stringify(store, null, 2)}\n`, {
      encoding: 'utf-8',
      flag: 'wx',
      mode: 0o600,
    });
    if (process.platform !== 'win32') chmodSync(tempPath, 0o600);
    renameSync(tempPath, path);
    if (process.platform !== 'win32') chmodSync(path, 0o600);
  } finally {
    rmSync(tempPath, { force: true });
  }
}

function ensurePrivateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') chmodSync(path, 0o700);
}

function readLockId(path: string): string | undefined {
  try {
    const value = JSON.parse(readFileSync(path, 'utf-8')) as { lockId?: unknown };
    return typeof value.lockId === 'string' ? value.lockId : undefined;
  } catch {
    return undefined;
  }
}

function malformedStoreError(path: string, cause?: unknown): XaiOAuthError {
  const detail = cause instanceof Error ? `: ${cause.message}` : '';
  return new XaiOAuthError(
    `xAI auth store is malformed and was preserved at ${path}${detail}`,
    'xai_auth_store_malformed',
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
