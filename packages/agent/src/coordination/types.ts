/**
 * @los/agent/coordination — Coordination primitives for single and mesh deployments.
 *
 * Provides lock, lease, and notify primitives that work identically whether
 * the agent runs as a single process or in a multi-gateway mesh.
 *
 * State-first design: these primitives are the coordination substrate, not
 * the business logic. Claim patterns (governance job claim, DAG task claim,
 * file sync dequeue) are built ON TOP of these primitives, not inside them.
 *
 * Mesh mode:   PostgreSQL advisory locks + NOTIFY + LISTEN
 * Single mode: in-process Mutex + EventEmitter (no PG required)
 */

// ── Lock ──────────────────────────────────────────────────

/**
 * Acquire an exclusive lock. In mesh mode this maps to pg_advisory_lock.
 * Returns a release function. The lock is held until release() is called
 * or the process exits.
 *
 * IMPORTANT: always call release() in a finally block.
 */
export interface LockBackend {
  /** Blocking lock acquisition. Only returns when lock is acquired. */
  acquire(key: string): Promise<() => Promise<void>>;

  /**
   * Non-blocking lock attempt. Returns null immediately if the lock is
   * already held by another process.
   */
  tryAcquire(key: string): Promise<{ release: () => Promise<void> } | null>;

  /**
   * Execute fn while holding the lock. Handles acquire + release.
   * If the lock cannot be acquired (tryAcquire mode), fn is not called
   * and the result is null.
   */
  withLock<T>(key: string, fn: () => Promise<T>): Promise<T | null>;
}

// ── Lease ─────────────────────────────────────────────────

export interface LeaseHandle {
  /** The resource being leased. */
  resource: string;
  /** Who holds the lease (nodeId or processId). */
  owner: string;
  /** When the lease expires. */
  expiresAt: Date;
  /** Opaque backend data (e.g., PG row id). */
  metadata?: Record<string, unknown>;
}

export interface LeaseBackend {
  /**
   * Acquire a lease on a resource. Returns null if the resource is
   * already leased by another owner and the lease hasn't expired.
   */
  acquire(resource: string, ttlMs: number, owner: string): Promise<LeaseHandle | null>;

  /**
   * Refresh a lease. Returns true if the lease is still valid.
   * Returns false if the lease expired or was claimed by another owner.
   */
  heartbeat(handle: LeaseHandle, ttlMs?: number): Promise<boolean>;

  /**
   * Find and recover leases that have exceeded their TTL.
   * Returns the recovered lease handles (now owned by the caller).
   */
  reapExpired(resourcePattern: string): Promise<LeaseHandle[]>;

  /** Release a lease voluntarily. */
  release(handle: LeaseHandle): Promise<void>;
}

// ── Notify ────────────────────────────────────────────────

export interface NotifyBackend {
  /**
   * Publish a message to a channel. In mesh mode this uses PG NOTIFY.
   * Best-effort: failures are logged but do not throw.
   */
  publish(channel: string, payload: unknown): Promise<void>;

  /**
   * Subscribe to a channel. Returns an unsubscribe function.
   * The handler receives the parsed payload (JSON).
   */
  subscribe(channel: string, handler: (payload: unknown) => void): () => void;

  /**
   * Subscribe with a fallback interval. If the push notification channel
   * is unavailable (e.g., PG LISTEN failed), the handler is called on
   * the fallback interval instead.
   */
  subscribeWithFallback(
    channel: string,
    handler: (payload: unknown) => void,
    fallbackIntervalMs: number,
  ): { unsubscribe: () => void; fallbackTimer?: ReturnType<typeof setInterval> };
}

// ── Backend ───────────────────────────────────────────────

export type CoordinationMode = 'mesh' | 'single';

export interface CoordinationBackend {
  readonly mode: CoordinationMode;
  readonly lock: LockBackend;
  readonly lease: LeaseBackend;
  readonly notify: NotifyBackend;
}
