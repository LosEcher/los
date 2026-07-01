/**
 * @los/agent/coordination/memory-backend — In-process coordination for single deployments.
 *
 * No external dependencies. Uses async-lock (Mutex) for locking and
 * EventEmitter for notifications. Leases use in-process timers.
 *
 * This is the backend used when LOS_MESH_MODE is off or when no PG
 * database is available.
 */

import type {
  LockBackend,
  LeaseBackend,
  LeaseHandle,
  NotifyBackend,
  CoordinationBackend,
} from './types.js';

// ── Mutex (lightweight in-process lock) ───────────────────

class Mutex {
  private _locked = false;
  private _queue: Array<() => void> = [];

  async acquire(): Promise<void> {
    if (!this._locked) {
      this._locked = true;
      return;
    }
    return new Promise<void>(resolve => {
      this._queue.push(resolve);
    });
  }

  release(): void {
    const next = this._queue.shift();
    if (next) {
      next();
    } else {
      this._locked = false;
    }
  }

  get locked(): boolean {
    return this._locked;
  }
}

// ── Lock Backend ───────────────────────────────────────────

class MemoryLockBackend implements LockBackend {
  private locks = new Map<string, Mutex>();

  private getOrCreate(key: string): Mutex {
    let m = this.locks.get(key);
    if (!m) {
      m = new Mutex();
      this.locks.set(key, m);
    }
    return m;
  }

  async acquire(key: string): Promise<() => Promise<void>> {
    const m = this.getOrCreate(key);
    await m.acquire();
    let released = false;
    return async () => {
      if (released) return;
      released = true;
      m.release();
    };
  }

  async tryAcquire(key: string): Promise<{ release: () => Promise<void> } | null> {
    const m = this.getOrCreate(key);
    if (m.locked) return null;
    await m.acquire();
    let released = false;
    return {
      release: async () => {
        if (released) return;
        released = true;
        m.release();
      },
    };
  }

  async withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const release = await this.acquire(key);
    try {
      return await fn();
    } finally {
      await release();
    }
  }
}

// ── Lease Backend ──────────────────────────────────────────

interface InMemoryLease {
  resource: string;
  owner: string;
  expiresAt: Date;
  metadata?: Record<string, unknown>;
}

class MemoryLeaseBackend implements LeaseBackend {
  private leases = new Map<string, InMemoryLease>();
  private reaperTimer?: ReturnType<typeof setInterval>;

  /**
   * Optional: start a background reaper that cleans up expired leases.
   * Useful for long-running processes. Not required — reapExpired()
   * can be called explicitly.
   */
  startReaper(intervalMs: number = 30_000): void {
    if (this.reaperTimer) return;
    this.reaperTimer = setInterval(() => {
      const now = new Date();
      for (const [key, lease] of this.leases) {
        if (lease.expiresAt < now) {
          this.leases.delete(key);
        }
      }
    }, intervalMs);
  }

  stopReaper(): void {
    if (this.reaperTimer) {
      clearInterval(this.reaperTimer);
      this.reaperTimer = undefined;
    }
  }

  async acquire(resource: string, ttlMs: number, owner: string): Promise<LeaseHandle | null> {
    const existing = this.leases.get(resource);
    if (existing && existing.expiresAt > new Date()) {
      // Existing lease is still valid
      if (existing.owner !== owner) return null;
      // Same owner re-acquiring — refresh
      existing.expiresAt = new Date(Date.now() + ttlMs);
      return toLeaseHandle(existing);
    }
    const entry: InMemoryLease = {
      resource,
      owner,
      expiresAt: new Date(Date.now() + ttlMs),
    };
    this.leases.set(resource, entry);
    return toLeaseHandle(entry);
  }

  async heartbeat(handle: LeaseHandle, ttlMs?: number): Promise<boolean> {
    const existing = this.leases.get(handle.resource);
    if (!existing || existing.owner !== handle.owner) return false;
    if (existing.expiresAt < new Date()) {
      this.leases.delete(handle.resource);
      return false;
    }
    existing.expiresAt = new Date(Date.now() + (ttlMs ?? 300_000));
    return true;
  }

  async reapExpired(resourcePattern: string): Promise<LeaseHandle[]> {
    const now = new Date();
    const pattern = new RegExp(resourcePattern.replace(/\*/g, '.*'));
    const recovered: LeaseHandle[] = [];
    for (const [key, lease] of this.leases) {
      if (pattern.test(key) && lease.expiresAt < now) {
        recovered.push(toLeaseHandle(lease));
        this.leases.delete(key);
      }
    }
    return recovered;
  }

  async release(handle: LeaseHandle): Promise<void> {
    const existing = this.leases.get(handle.resource);
    if (existing && existing.owner === handle.owner) {
      this.leases.delete(handle.resource);
    }
  }
}

// ── Notify Backend ─────────────────────────────────────────

type NotifyHandler = (payload: unknown) => void;

class MemoryNotifyBackend implements NotifyBackend {
  private channels = new Map<string, Set<NotifyHandler>>();

  async publish(channel: string, payload: unknown): Promise<void> {
    const handlers = this.channels.get(channel);
    if (!handlers) return;
    // Deliver asynchronously to avoid blocking the publisher
    for (const handler of handlers) {
      setImmediate(() => {
        try { handler(payload); } catch { /* best-effort */ }
      });
    }
  }

  subscribe(channel: string, handler: NotifyHandler): () => void {
    let handlers = this.channels.get(channel);
    if (!handlers) {
      handlers = new Set();
      this.channels.set(channel, handlers);
    }
    handlers.add(handler);
    return () => {
      handlers?.delete(handler);
      if (handlers?.size === 0) this.channels.delete(channel);
    };
  }

  subscribeWithFallback(
    channel: string,
    handler: (payload: unknown) => void,
    fallbackIntervalMs: number,
  ): { unsubscribe: () => void; fallbackTimer?: ReturnType<typeof setInterval> } {
    const unsubscribe = this.subscribe(channel, handler);
    const fallbackTimer = setInterval(() => handler({ _fallback: true, channel }), fallbackIntervalMs);
    const origUnsub = unsubscribe;
    return {
      unsubscribe: () => {
        origUnsub();
        clearInterval(fallbackTimer);
      },
      fallbackTimer,
    };
  }
}

// ── Helpers ────────────────────────────────────────────────

function toLeaseHandle(entry: InMemoryLease): LeaseHandle {
  return {
    resource: entry.resource,
    owner: entry.owner,
    expiresAt: entry.expiresAt,
    metadata: entry.metadata,
  };
}

// ── Factory ────────────────────────────────────────────────

export function createMemoryCoordinationBackend(): CoordinationBackend {
  return {
    mode: 'single',
    lock: new MemoryLockBackend(),
    lease: new MemoryLeaseBackend(),
    notify: new MemoryNotifyBackend(),
  };
}

export { MemoryLockBackend, MemoryLeaseBackend, MemoryNotifyBackend, Mutex };
