export interface OperatorAlertDeduperOptions {
  semanticTtlMs?: number;
  eventIdTtlMs?: number;
  maxEntries?: number;
}

interface RecentAlert {
  seenAt: number;
  ttlMs: number;
}

export class OperatorAlertDeduper {
  private readonly recent = new Map<string, RecentAlert>();
  private readonly semanticTtlMs: number;
  private readonly eventIdTtlMs: number;
  private readonly maxEntries: number;

  constructor(options: OperatorAlertDeduperOptions = {}) {
    this.semanticTtlMs = options.semanticTtlMs ?? 60_000;
    this.eventIdTtlMs = options.eventIdTtlMs ?? 24 * 60 * 60_000;
    this.maxEntries = options.maxEntries ?? 1_000;
  }

  shouldSuppress(input: {
    eventId?: unknown;
    fallbackKey: string;
    now?: number;
  }): boolean {
    const now = input.now ?? Date.now();
    const eventId = normalizeEventId(input.eventId);
    const key = eventId === undefined ? input.fallbackKey : `event:${eventId}`;
    const ttlMs = eventId === undefined ? this.semanticTtlMs : this.eventIdTtlMs;
    const previous = this.recent.get(key);
    if (previous && now - previous.seenAt < previous.ttlMs) return true;

    this.recent.set(key, { seenAt: now, ttlMs });
    if (this.recent.size > this.maxEntries) this.cleanup(now);
    return false;
  }

  private cleanup(now: number): void {
    for (const [key, entry] of this.recent) {
      if (now - entry.seenAt >= entry.ttlMs) this.recent.delete(key);
    }
  }
}

function normalizeEventId(value: unknown): number | undefined {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}
