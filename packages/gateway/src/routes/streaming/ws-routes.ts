/**
 * WebSocket stream route — bidirectional event relay.
 *
 * Provides GET /sessions/:id/stream/ws for WebSocket upgrade, relaying
 * the same session_events + stream_checkpoints as the SSE surface but
 * with a full-duplex channel. The WS transport enables:
 *   - tool interaction from remote clients
 *   - operator steering with message acknowledgment
 *   - lower-latency event push vs SSE poll
 *
 * Connected clients receive session events in real time and can send
 * operator control messages (steering, cancellation) back to the server.
 */

import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import { ensureSessionEventStore, listSessionEventsSince } from '@los/agent/session-events';
import { recordOperatorSteering } from '@los/agent/operator-control';
import {
  acquireStreamLease,
  releaseStreamLease,
  heartbeatStreamLease,
  type ReconnectInfo,
} from '@los/agent/stream-lease';
import { eventBus } from '@los/agent/event-bus';
import { computeRetryDelay, retryAfterHeader } from './stream-backoff.js';
import { hasOperatorAccess } from '../../request-context.js';

interface WsClient {
  ws: WebSocket;
  sessionId: string;
  lastId: number;
  lease: ReconnectInfo;
  gateway: string;
}

const wsClients = new Map<number, WsClient>();
let wsClientSeq = 0;

function wsSend(ws: WebSocket, event: string, data: unknown, eventId?: number) {
  if (ws.readyState !== ws.OPEN) return;
  try {
    ws.send(JSON.stringify({ event, data, id: eventId }));
  } catch {
    // Best-effort; client may have disconnected
  }
}

export function registerWsRoutes(app: FastifyInstance, gatewayServiceId: string): void {
  /**
   * GET /sessions/:id/stream/ws
   *
   * WebSocket upgrade. Accepts ?since=N for reconnect.
   *
   * Client → Server messages:
   *   { type: "ping" }
   *   { type: "steering", instruction, reason?, turnBoundary? }
   *   { type: "cancel", reason? } — maps to deny steering
   *
   * Server → Client: session.* events, ping, steering.ack, error
   */
  app.get('/sessions/:id/stream/ws', { websocket: true }, async (socket, req) => {
    const { id } = req.params as { id: string };
    const params = req.query as { since?: string };
    const since = Math.max(0, Number(params.since ?? 0));
    const gateway = gatewayServiceId;

    // ── Lease acquire ──
    const lease = await acquireStreamLease({ sessionId: id, gateway, ttlSeconds: 30 });
    if (!lease.canTakeover) {
      socket.send(JSON.stringify({
        event: 'error',
        data: {
          error: 'session_stream_conflict',
          message: lease.reason,
          gateway: lease.previousLease?.gateway ?? null,
          retryAfterSec: Number(retryAfterHeader(computeRetryDelay(1))),
          retryBackoff: { baseMs: 1000, maxMs: 120000, factor: 2.0, jitter: true },
        },
      }));
      socket.close(4001, lease.reason);
      return;
    }

    await ensureSessionEventStore();

    const cid = ++wsClientSeq;
    const client: WsClient = { ws: socket, sessionId: id, lastId: since, lease, gateway };
    wsClients.set(cid, client);

    // ── Heartbeat ──
    const leaseHeartbeat = setInterval(() => {
      heartbeatStreamLease(id, gateway).catch(() => undefined);
    }, 10_000);

    const pingInterval = setInterval(() => {
      if (socket.readyState === socket.OPEN) {
        socket.send(JSON.stringify({ event: 'ping', data: { ts: Date.now() } }));
      }
    }, 15_000);

    // ── Replay catch-up ──
    if (since > 0) {
      const initial = await listSessionEventsSince(id, since, 200);
      for (const event of initial) {
        wsSend(socket, event.type, {
          id: event.id,
          sessionId: event.sessionId,
          turn: event.turn,
          type: event.type,
          source: event.source,
          model: event.model ?? null,
          toolName: event.toolName ?? null,
          usage: event.usage ?? null,
          payload: event.payload,
          createdAt: event.createdAt,
        }, event.id);
        client.lastId = event.id;
      }
      wsSend(socket, 'session.resumed', {
        sessionId: id,
        since,
        gateway,
        leaseId: lease.newLease?.leaseId ?? null,
        eventsDelivered: initial.length,
      });
    }

    // ── EventBus subscription ──
    const unsubBus = eventBus.on('execution:transition', (payload) => {
      if (payload.sessionId !== id) return;
      listSessionEventsSince(id, client.lastId, 100).then(events => {
        for (const event of events) {
          if (event.id <= client.lastId) continue;
          wsSend(socket, event.type, {
            id: event.id,
            sessionId: event.sessionId,
            turn: event.turn,
            type: event.type,
            source: event.source,
            model: event.model ?? null,
            toolName: event.toolName ?? null,
            usage: event.usage ?? null,
            payload: event.payload,
            createdAt: event.createdAt,
          }, event.id);
          client.lastId = event.id;
        }
      }).catch(() => undefined);
    });

    // ── Poll fallback ──
    const pollInterval = setInterval(async () => {
      try {
        const events = await listSessionEventsSince(id, client.lastId, 100);
        for (const event of events) {
          wsSend(socket, event.type, {
            id: event.id,
            sessionId: event.sessionId,
            turn: event.turn,
            type: event.type,
            source: event.source,
            model: event.model ?? null,
            toolName: event.toolName ?? null,
            usage: event.usage ?? null,
            payload: event.payload,
            createdAt: event.createdAt,
          }, event.id);
          client.lastId = event.id;
        }
      } catch {
        // Poll failure not terminal; EventBus is primary push
      }
    }, 2000);

    // ── Client messages ──
    socket.on('message', (raw) => {
      void (async () => {
        try {
          const msg = JSON.parse(raw.toString()) as Record<string, unknown>;
          if (msg.type === 'ping') {
            wsSend(socket, 'pong', { ts: Date.now() });
            return;
          }

          if (msg.type === 'steering' || msg.type === 'cancel') {
            if (!hasOperatorAccess(req)) {
              wsSend(socket, 'error', { error: 'operator_required' });
              return;
            }
            const instruction = msg.type === 'cancel'
              ? 'deny'
              : typeof msg.instruction === 'string'
                ? msg.instruction
                : '';
            if (!instruction) {
              wsSend(socket, 'error', { error: 'steering_instruction_required' });
              return;
            }
            const turnBoundary = msg.turnBoundary === 'next_turn' ? 'next_turn' : 'immediate';
            const reason = typeof msg.reason === 'string' ? msg.reason : `ws ${msg.type}`;
            try {
              const event = await recordOperatorSteering({
                sessionId: id,
                instruction,
                turnBoundary,
                reason,
                actor: 'ws-client',
              });
              wsSend(socket, 'steering.ack', {
                ok: true,
                type: msg.type,
                instruction,
                eventId: event.id,
                eventType: event.type,
              });
            } catch (err) {
              const message = err instanceof Error ? err.message : String(err);
              wsSend(socket, 'error', { error: 'steering_failed', message });
            }
          }
        } catch {
          // Ignore malformed messages
        }
      })();
    });

    socket.on('close', () => {
      unsubBus();
      clearInterval(leaseHeartbeat);
      clearInterval(pingInterval);
      clearInterval(pollInterval);
      wsClients.delete(cid);
      releaseStreamLease(id, gateway).catch(() => undefined);
    });

    socket.on('error', () => {
      unsubBus();
      clearInterval(leaseHeartbeat);
      clearInterval(pingInterval);
      clearInterval(pollInterval);
      wsClients.delete(cid);
      releaseStreamLease(id, gateway).catch(() => undefined);
    });
  });
}

/**
 * Push an event to all connected WS clients for a session.
 * Used by chat-live-events and PG NOTIFY handler.
 */
export function pushWsEvent(
  sessionId: string,
  event: string,
  data: unknown,
  eventId?: number,
): void {
  for (const [, client] of wsClients) {
    if (client.sessionId !== sessionId) continue;
    wsSend(client.ws, event, data, eventId);
    if (eventId) client.lastId = Math.max(client.lastId, eventId);
  }
}
