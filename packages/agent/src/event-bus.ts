/**
 * @los/agent/event-bus — In-process typed event bus.
 *
 * Replaces execution_outbox polling for same-process event consumers.
 * Cross-gateway push continues via PG NOTIFY. The outbox table remains
 * as the durable audit ledger but is no longer polled for live consumption.
 */

import { EventEmitter } from 'node:events';

// ── Event type registry ─────────────────────────────────────────────

export interface EventBusEvents {
  /** Execution state transition completed. Payload matches TransitionExecutionStateResult. */
  'execution:transition': {
    entityType: string;
    entityId: string;
    sessionId: string;
    from: string;
    to: string;
    reason: string;
    eventId: number;
    outboxId: number;
    runSpecId?: string;
    taskRunId?: string;
    commandId?: string;
    causationId?: string;
    correlationId?: string;
    nodeId?: string;
    attempt?: number;
  };

  /** Session event appended (also emitted for internal events that don't go through transitionExecutionState). */
  'session:event': {
    sessionId: string;
    eventId: number;
    type: string;
    channel: string;
  };

  /** Governance sweep wake signal — emitted by PG LISTEN handler or in-process job completion. */
  'governance:sweep-wake': {};
}

type EventKey = keyof EventBusEvents;

// ── Bus ────────────────────────────────────────────────────────────

class EventBusImpl {
  private emitter = new EventEmitter();
  /** Maximum listeners per event type before Node warns. */
  private maxListeners = 64;

  constructor() {
    this.emitter.setMaxListeners(this.maxListeners);
  }

  /** Emit a typed event. */
  emit<K extends EventKey>(event: K, payload: EventBusEvents[K]): void {
    this.emitter.emit(event, payload);
  }

  /** Subscribe to a typed event. Returns an unsubscribe function. */
  on<K extends EventKey>(event: K, handler: (payload: EventBusEvents[K]) => void): () => void {
    this.emitter.on(event, handler);
    return () => { this.emitter.off(event, handler); };
  }

  /** Subscribe for a single invocation. */
  once<K extends EventKey>(event: K, handler: (payload: EventBusEvents[K]) => void): void {
    this.emitter.once(event, handler);
  }

  /** Remove all listeners for an event, or all listeners entirely. */
  removeAllListeners(event?: EventKey): void {
    if (event) {
      this.emitter.removeAllListeners(event);
    } else {
      this.emitter.removeAllListeners();
    }
  }

  /** Current listener count for an event. */
  listenerCount(event: EventKey): number {
    return this.emitter.listenerCount(event);
  }
}

// Singleton — one bus per process.
export const eventBus = new EventBusImpl();
