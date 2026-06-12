import type { FastifyInstance } from 'fastify';
import { getPool } from '@los/infra/db';
import { ensureSessionEventStore, listSessionEventsSince } from '@los/agent/session-events';
import { ensureTaskRunStore, listTaskRunsForSession, loadTaskRun } from '@los/agent/task-runs';

interface LiveClient {
  sessionId: string;
  reply: any;
  lastId: number;
  ended: boolean;
}

const liveClients = new Map<number, LiveClient>();
let clientSeq = 0;

function parseLiveSessionEventNotification(payload: string | undefined) {
  if (!payload) return null;
  try {
    const obj = JSON.parse(payload);
    if (obj && typeof obj === 'object' && typeof obj.session_id === 'string') {
      return {
        sessionId: obj.session_id as string,
        channel: (typeof obj.channel === 'string' ? obj.channel : 'session_events') as string,
        eventId: typeof obj.event_id === 'number' ? obj.event_id : undefined as number | undefined,
      };
    }
    return null;
  } catch {
    return null;
  }
}

export function registerSseRoutes(app: FastifyInstance): void {
  app.get('/sessions/:id/events/stream', async (req, reply) => {
    const { id } = req.params as { id: string };
    // Support Last-Event-ID header (sent by EventSource on reconnect) — overrides query param
    const lastEventId = req.headers['last-event-id'];
    const since = lastEventId
      ? Math.max(0, Number(lastEventId))
      : Math.max(0, Number((req.query as { since?: string }).since ?? 0));

    await ensureSessionEventStore();
    await ensureTaskRunStore();

    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    const send = (event: string, data: unknown, eventId?: number) => {
      if (eventId !== undefined) reply.raw.write(`id: ${eventId}\n`);
      reply.raw.write(`event: ${event}\n`);
      reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    let lastId = since;
    let ended = false;

    const pollAndSend = async () => {
      if (ended) return 0;
      const events = await listSessionEventsSince(id, lastId, 100);
      for (const event of events) {
        send(event.type, {
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
        lastId = event.id;
      }
      return events.length;
    };

    try {
      await pollAndSend();

      const activeTasks = await listTaskRunsForSession(id, 5);
      const active = activeTasks.find(t => t.status === 'queued' || t.status === 'running');

      if (active) {
        send('session.live', {
          sessionId: id, taskRunId: active.id, status: active.status,
          message: 'Session has active task. Streaming live events...',
        });

        // Register as a live client so PG NOTIFY triggers instant push
        const cid = ++clientSeq;
        liveClients.set(cid, { sessionId: id, reply, lastId, ended: false });

        const interval = setInterval(async () => {
          try {
            await pollAndSend();
            const client = liveClients.get(cid);
            if (client) client.lastId = lastId;
            const task = await loadTaskRun(active.id);
            if (!task || !['queued', 'running'].includes(task.status)) {
              ended = true;
              liveClients.delete(cid);
              clearInterval(interval);
              send('session.completed', {
                sessionId: id, taskRunId: active.id,
                status: task?.status ?? 'unknown',
              });
              reply.raw.end();
            }
          } catch {
            liveClients.delete(cid);
            clearInterval(interval);
            reply.raw.end();
          }
        }, 1000);

        req.raw.on('close', () => {
          liveClients.delete(cid);
          clearInterval(interval);
        });
      } else {
        send('session.completed', {
          sessionId: id, message: 'No active task. All events delivered.',
        });
        reply.raw.end();
      }
    } catch (err: any) {
      send('error', { message: err?.message ?? String(err) });
      reply.raw.end();
    }
  });
}

/**
 * Wire PG NOTIFY → SSE push.
 *
 * When appendSessionEvent calls pg_notify('session_events', ...), this listener
 * wakes up registered SSE clients and pushes new events immediately, eliminating
 * the 1s polling delay.
 */
export function setupLiveEventPush(app: FastifyInstance): void {
  const pool = getPool();
  if (!pool) return;

  let client: any = null;

  app.addHook('onReady', async () => {
    try {
      client = await pool.connect();
      await client.query('LISTEN session_events');

      client.on('notification', async (msg: any) => {
        const parsed = parseLiveSessionEventNotification(msg.payload);
        if (!parsed) return;

        // Push to any live client watching this session
        for (const [cid, lc] of liveClients) {
          if (lc.sessionId !== parsed.sessionId || lc.ended) continue;
          try {
            const events = await listSessionEventsSince(lc.sessionId, lc.lastId, 100);
            for (const event of events) {
              if (event.id <= lc.lastId) continue;
              lc.reply.raw.write(`id: ${event.id}\n`);
              lc.reply.raw.write(`event: ${event.type}\n`);
              lc.reply.raw.write(`data: ${JSON.stringify({
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
              })}\n\n`);
              lc.lastId = event.id;
            }
          } catch {
            lc.ended = true;
            liveClients.delete(cid);
          }
        }
      });

      client.on('error', () => {
        // Connection errors on the LISTEN client are non-fatal;
        // the per-connection polling fallback ensures liveness.
      });
    } catch {
      // Pool or LISTEN unavailable — all connections fall back to polling
    }
  });

  app.addHook('onClose', async () => {
    if (client) {
      try { client.release(); } catch { /* ignore */ }
    }
  });
}

export function registerLiveEventRoutes(app: FastifyInstance): void {
  app.get('/sessions/:id/events/live', async (req, reply) => {
    const { id } = req.params as { id: string };
    const lastEventId = req.headers['last-event-id'];
    const since = lastEventId
      ? Math.max(0, Number(lastEventId))
      : Math.max(0, Number((req.query as { since?: string }).since ?? 0));

    await ensureSessionEventStore();

    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    const send = (event: string, data: unknown, eventId?: number) => {
      if (eventId !== undefined) reply.raw.write(`id: ${eventId}\n`);
      reply.raw.write(`event: ${event}\n`);
      reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    let lastId = since;
    let ended = false;

    const pollAndSend = async () => {
      if (ended) return 0;
      const events = await listSessionEventsSince(id, lastId, 100);
      for (const event of events) {
        send('session.event', { id: event.id, sessionId: event.sessionId, type: event.type, payload: event.payload }, event.id);
        lastId = event.id;
      }
      return events.length;
    };

    try {
      await pollAndSend();
      send('session.ready', { sessionId: id, lastEventId: lastId });

      // Register for NOTIFY push
      const cid = ++clientSeq;
      liveClients.set(cid, { sessionId: id, reply, lastId, ended: false });

      const interval = setInterval(async () => {
        try {
          await pollAndSend();
          const client = liveClients.get(cid);
          if (client) client.lastId = lastId;
        } catch {
          liveClients.delete(cid);
          clearInterval(interval);
          reply.raw.end();
        }
      }, 1000);

      req.raw.on('close', () => { ended = true; liveClients.delete(cid); clearInterval(interval); });
    } catch (err: any) {
      send('error', { message: err?.message ?? String(err) });
      reply.raw.end();
    }
  });
}
