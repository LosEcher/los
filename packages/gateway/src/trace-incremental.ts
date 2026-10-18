import {
  foldSessionTrace,
  type SessionTraceFold,
  type SessionTraceProjection,
  type SessionTraceSeed,
} from '@los/agent/session-trace';
import type { SessionEventRecord } from '@los/agent/session-events';

/**
 * Per-instance carry state for the incremental trace endpoint.
 *
 * The fold is a pure function of (events, seed); this module only remembers the
 * seed a cursor produced so the next poll with that cursor resumes instead of
 * re-folding a window that no longer contains the tool call it needs. A miss is
 * a cost problem, never a correctness problem: the caller passes `fullEvents`
 * and gets the same projection from a full fold.
 */
const TRACE_SEED_CACHE_LIMIT = 1024;
const traceSeedCache = new Map<string, SessionTraceSeed>();

function traceSeedKey(sessionId: string, since: number): string {
  return `${sessionId}:${since}`;
}

export function rememberTraceSeed(sessionId: string, since: number, seed: SessionTraceSeed): void {
  traceSeedCache.delete(traceSeedKey(sessionId, since));
  traceSeedCache.set(traceSeedKey(sessionId, since), seed);
  while (traceSeedCache.size > TRACE_SEED_CACHE_LIMIT) {
    const oldest = traceSeedCache.keys().next().value;
    if (oldest === undefined) break;
    traceSeedCache.delete(oldest);
  }
}

export function readTraceSeed(sessionId: string, since: number): SessionTraceSeed | undefined {
  return traceSeedCache.get(traceSeedKey(sessionId, since));
}

/** Test hook: the cache is process state, so tests must be able to clear it. */
export function resetTraceSeedCache(): void {
  traceSeedCache.clear();
}

export type TraceWindowFold = {
  projection: SessionTraceProjection;
  nextSince: number;
  seed: SessionTraceSeed;
  /** True when the window was folded on top of a carried seed. */
  resumed: boolean;
};

/**
 * Fold one incremental window and advance the cursor.
 *
 * `nextSince` is always `max(since, seed.lastEventId)` so the cursor a client
 * sends back is exactly the cursor this module caches the next seed under.
 */
export function foldTraceWindow(
  args: {
    sessionId: string;
    since: number;
    newEvents: SessionEventRecord[];
    /** Required when no seed is cached for (sessionId, since). */
    fullEvents?: SessionEventRecord[];
  },
  fold: typeof foldSessionTrace = foldSessionTrace,
): TraceWindowFold {
  const carried = readTraceSeed(args.sessionId, args.since);
  const events = carried ? args.newEvents : args.fullEvents;
  if (!events) {
    throw new Error('foldTraceWindow requires fullEvents when no seed is cached');
  }

  const folded: SessionTraceFold = carried
    ? fold(args.sessionId, events, carried)
    : fold(args.sessionId, events);

  const nextSince = Math.max(args.since, folded.seed.lastEventId);
  rememberTraceSeed(args.sessionId, nextSince, folded.seed);
  return { projection: folded.projection, nextSince, seed: folded.seed, resumed: Boolean(carried) };
}
