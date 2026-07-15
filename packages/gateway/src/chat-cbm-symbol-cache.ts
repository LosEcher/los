import { CBMClient } from '@los/memory';

export interface CachedSymbolRef {
  id: string;
  name: string;
  kind: string;
  file: string;
}

export interface SymbolCacheMetrics {
  activeSessions: number;
  cachedCalls: number;
  pendingResolutions: number;
  stores: number;
  drains: number;
  clears: number;
  failedSessionCleanups: number;
  expiredSessions: number;
  expiredCalls: number;
  capacitySessionEvictions: number;
  capacityCallEvictions: number;
  lateWriteDrops: number;
  resolutionFailures: number;
  ttlMs: number;
  maxSessions: number;
  maxCallsPerSession: number;
}

interface CacheEntry {
  token: number;
  calls: Map<string, CachedSymbolRef[]>;
  pendingResolutions: number;
  expiresAt: number;
  lastAccessAt: number;
}

interface CacheCounters {
  stores: number;
  drains: number;
  clears: number;
  failedSessionCleanups: number;
  expiredSessions: number;
  expiredCalls: number;
  capacitySessionEvictions: number;
  capacityCallEvictions: number;
  lateWriteDrops: number;
  resolutionFailures: number;
}

export class _SessionSymbolCache {
  private readonly entries = new Map<string, CacheEntry>();
  private nextToken = 1;
  private readonly counters: CacheCounters = {
    stores: 0,
    drains: 0,
    clears: 0,
    failedSessionCleanups: 0,
    expiredSessions: 0,
    expiredCalls: 0,
    capacitySessionEvictions: 0,
    capacityCallEvictions: 0,
    lateWriteDrops: 0,
    resolutionFailures: 0,
  };

  constructor(private readonly options: {
    ttlMs: number;
    maxSessions: number;
    maxCallsPerSession: number;
    now?: () => number;
  }) {}

  beginResolution(sessionId: string): number {
    this.sweepExpired();
    const now = this.now();
    let entry = this.entries.get(sessionId);
    if (!entry) {
      this.evictSessionForCapacity();
      entry = {
        token: this.nextToken++,
        calls: new Map(),
        pendingResolutions: 0,
        expiresAt: now + this.options.ttlMs,
        lastAccessAt: now,
      };
      this.entries.set(sessionId, entry);
    }
    entry.pendingResolutions += 1;
    this.touch(entry, now);
    return entry.token;
  }

  completeResolution(
    sessionId: string,
    token: number,
    callId: string,
    symbols: CachedSymbolRef[],
  ): boolean {
    const entry = this.entries.get(sessionId);
    if (!entry || entry.token !== token) {
      this.counters.lateWriteDrops += 1;
      return false;
    }
    entry.pendingResolutions = Math.max(0, entry.pendingResolutions - 1);
    if (symbols.length > 0) {
      if (!entry.calls.has(callId) && entry.calls.size >= this.options.maxCallsPerSession) {
        const oldestCallId = entry.calls.keys().next().value as string | undefined;
        if (oldestCallId) entry.calls.delete(oldestCallId);
        this.counters.capacityCallEvictions += 1;
      }
      entry.calls.delete(callId);
      entry.calls.set(callId, symbols);
      this.counters.stores += 1;
    }
    this.touch(entry, this.now());
    return true;
  }

  failResolution(sessionId: string, token: number): void {
    this.counters.resolutionFailures += 1;
    const entry = this.entries.get(sessionId);
    if (!entry || entry.token !== token) {
      this.counters.lateWriteDrops += 1;
      return;
    }
    entry.pendingResolutions = Math.max(0, entry.pendingResolutions - 1);
    if (entry.pendingResolutions === 0 && entry.calls.size === 0) {
      this.entries.delete(sessionId);
      this.counters.failedSessionCleanups += 1;
    }
  }

  drain(sessionId: string): Map<string, CachedSymbolRef[]> {
    this.sweepExpired();
    const entry = this.entries.get(sessionId);
    if (!entry) return new Map();
    this.entries.delete(sessionId);
    this.counters.drains += 1;
    return new Map(entry.calls);
  }

  clear(sessionId: string): boolean {
    const cleared = this.entries.delete(sessionId);
    if (cleared) this.counters.clears += 1;
    return cleared;
  }

  sweepExpired(): number {
    const now = this.now();
    let removed = 0;
    for (const [sessionId, entry] of this.entries) {
      if (entry.expiresAt > now) continue;
      this.entries.delete(sessionId);
      this.counters.expiredSessions += 1;
      this.counters.expiredCalls += entry.calls.size;
      removed += 1;
    }
    return removed;
  }

  metrics(): SymbolCacheMetrics {
    let cachedCalls = 0;
    let pendingResolutions = 0;
    for (const entry of this.entries.values()) {
      cachedCalls += entry.calls.size;
      pendingResolutions += entry.pendingResolutions;
    }
    return {
      activeSessions: this.entries.size,
      cachedCalls,
      pendingResolutions,
      ...this.counters,
      ttlMs: this.options.ttlMs,
      maxSessions: this.options.maxSessions,
      maxCallsPerSession: this.options.maxCallsPerSession,
    };
  }

  private evictSessionForCapacity(): void {
    if (this.entries.size < this.options.maxSessions) return;
    let oldest: [string, CacheEntry] | undefined;
    for (const candidate of this.entries) {
      if (!oldest || candidate[1].lastAccessAt < oldest[1].lastAccessAt) oldest = candidate;
    }
    if (oldest) {
      this.entries.delete(oldest[0]);
      this.counters.capacitySessionEvictions += 1;
    }
  }

  private touch(entry: CacheEntry, now: number): void {
    entry.lastAccessAt = now;
    entry.expiresAt = now + this.options.ttlMs;
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }
}

const sessionCache = new _SessionSymbolCache({
  ttlMs: 15 * 60_000,
  maxSessions: 1_000,
  maxCallsPerSession: 100,
});

export async function cacheSymbolsForToolCall(
  sessionId: string,
  callId: string,
  tool: string,
  args: Record<string, unknown>,
  workspaceRoot?: string,
): Promise<void> {
  const paths = extractEditedPaths(tool, args);
  if (paths.length === 0) return;
  const token = sessionCache.beginResolution(sessionId);
  let cbm: CBMClient | undefined;

  try {
    cbm = CBMClient.createDefault();
    if (workspaceRoot) cbm.setWorkspaceRoot(workspaceRoot);
    await cbm.connect();
    const symbols = await cbm.resolveSymbols(paths.map(path => ({ path })));
    sessionCache.completeResolution(sessionId, token, callId, symbols.map(symbol => ({
      id: symbol.id,
      name: symbol.name,
      kind: symbol.kind,
      file: symbol.file,
    })));
  } catch {
    sessionCache.failResolution(sessionId, token);
  } finally {
    await cbm?.close().catch(() => undefined);
  }
}

export function drainSymbolCache(sessionId: string): Map<string, CachedSymbolRef[]> {
  return sessionCache.drain(sessionId);
}

export function clearSymbolCache(sessionId: string): boolean {
  return sessionCache.clear(sessionId);
}

export function getSymbolCacheMetrics(): SymbolCacheMetrics {
  sessionCache.sweepExpired();
  return sessionCache.metrics();
}

export function sweepSymbolCache(): number {
  return sessionCache.sweepExpired();
}

function extractEditedPaths(tool: string, args: Record<string, unknown>): string[] {
  const paths: string[] = [];
  if ((tool === 'multi_edit' || tool === 'write_edits') && Array.isArray(args.files)) {
    for (const file of args.files) {
      if (file && typeof file === 'object' && typeof (file as { file_path?: unknown }).file_path === 'string') {
        paths.push((file as { file_path: string }).file_path);
      }
    }
  } else if ((tool === 'write_file' || tool === 'write_to_file' || tool === 'replace') && typeof args.file_path === 'string') {
    paths.push(args.file_path);
  }
  return paths;
}
