/**
 * @los/memory/core/session-event-sink — injected session-event writer.
 *
 * `@los/memory` must not import `@los/agent`: the agent depends on memory for the
 * read model, so that direction is a layering inversion
 * (docs/architecture/2026-10-10-control-plane-truth-remediation.md §9).
 *
 * The gateway depends on both packages, so it registers the writer at start-up
 * (`registerSessionEventSink`). When no sink is registered, memory **does not**
 * silently pretend the event was written: it warns and reports the drop, and the
 * caller's compaction still succeeds — the same best-effort contract the previous
 * dynamic import had.
 */
import { getLogger } from '@los/infra/logger';

const log = getLogger('memory/session-events');

export interface MemorySessionEvent {
  sessionId: string;
  type: string;
  source?: string;
  tenantId?: string;
  projectId?: string;
  userId?: string;
  payload?: Record<string, unknown>;
}

export type MemorySessionEventSink = (event: MemorySessionEvent) => Promise<unknown>;

let sink: MemorySessionEventSink | undefined;

/** Wired once by the gateway (the only package that may know both sides). */
export function registerSessionEventSink(next: MemorySessionEventSink | undefined): void {
  sink = next;
}

/**
 * Emit one event through the injected sink.
 *
 * Returns whether it was written. Callers treat `false` as "dropped, already
 * warned" — never as an error worth failing the surrounding operation.
 */
export async function emitMemorySessionEvent(event: MemorySessionEvent): Promise<boolean> {
  if (!sink) {
    log.warn(
      `session-event sink not registered; dropping ${event.type} for session ${event.sessionId} (register it from the gateway)`,
    );
    return false;
  }
  await sink(event);
  return true;
}
