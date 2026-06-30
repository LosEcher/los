/**
 * @los/agent/event-log — Append-only event log abstraction.
 *
 * Provides a uniform interface for append-only event streams, supporting
 * both in-process (file-based) and distributed (PG-based) backends.
 *
 * Events are immutable, ordered, and identified by a monotonically
 * increasing event ID within each stream.
 *
 * This is the foundation for:
 *  - stream_checkpoints (high-frequency per-token events → file)
 *  - session_events cold storage (compacted JSONL archives)
 *  - future: agent execution replay from event log
 */

// ── Types ─────────────────────────────────────────────────

export interface EventLogEntry {
  /** Stream-wide unique event ID. Monotonically increasing. */
  id: number;
  /** The stream this event belongs to. */
  stream: string;
  /** Event type tag for filtering. */
  type: string;
  /** ISO 8601 timestamp. */
  timestamp: string;
  /** Arbitrary payload (serialized to JSON). */
  payload: Record<string, unknown>;
}

export interface AppendEventInput {
  type: string;
  payload?: Record<string, unknown>;
  timestamp?: string;
}

export interface ReadEventsOptions {
  /** Start reading after this event ID (exclusive). 0 = from beginning. */
  fromId?: number;
  /** Max events to return. */
  limit?: number;
  /** Only return events of this type. */
  type?: string;
}

export interface EventLogStats {
  stream: string;
  totalEvents: number;
  firstEventAt: string | null;
  lastEventAt: string | null;
  sizeBytes: number;
}

// ── Backend interface ──────────────────────────────────────

export interface EventLogBackend {
  /**
   * Append events to a stream. Returns the assigned event IDs.
   * Events within a single call are guaranteed to receive contiguous IDs.
   */
  append(stream: string, events: AppendEventInput[]): Promise<number[]>;

  /**
   * Read events from a stream.
   */
  read(stream: string, opts?: ReadEventsOptions): Promise<EventLogEntry[]>;

  /**
   * Get the ID of the last event in a stream.
   * Returns 0 if the stream is empty.
   */
  getLastEventId(stream: string): Promise<number>;

  /**
   * Get stream statistics.
   */
  getStats(stream: string): Promise<EventLogStats>;

  /**
   * Delete all events in a stream. Irreversible.
   * Used for temporary streams (e.g., completed stream checkpoints).
   */
  truncate(stream: string): Promise<void>;
}
