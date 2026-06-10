import type { FastifyInstance } from 'fastify';
import { getPool } from '@los/infra/db';
import { ensureSessionEventStore, listSessionEventsSince } from '@los/agent/session-events';
import { ensureTaskRunStore, listTaskRunsForSession, loadTaskRun } from '@los/agent/task-runs';

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

        const interval = setInterval(async () => {
          try {
            await pollAndSend();
            const task = await loadTaskRun(active.id);
            if (!task || !['queued', 'running'].includes(task.status)) {
              ended = true;
              clearInterval(interval);
              send('session.completed', {
                sessionId: id, taskRunId: active.id,
                status: task?.status ?? 'unknown',
              });
              reply.raw.end();
            }
          } catch {
            clearInterval(interval);
            reply.raw.end();
          }
        }, 1000);

        req.raw.on('close', () => clearInterval(interval));
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

export function setupLiveEventPush(app: FastifyInstance): void {
  const pool = getPool();
  if (!pool) return;

  app.addHook('onReady', async () => {
    try {
      const c: any = await pool.connect();
      await c.query('LISTEN session_events');
      c.on('notification', async (msg: any) => {
        parseLiveSessionEventNotification(msg.payload);
      });
      c.on('error', () => {});
      app.addHook('onClose', async () => {
        try { c.release(); } catch { /* ignore */ }
      });
    } catch { /* pool not available */ }
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

      const interval = setInterval(async () => {
        try { await pollAndSend(); } catch {
          clearInterval(interval);
          reply.raw.end();
        }
      }, 1000);

      req.raw.on('close', () => { ended = true; clearInterval(interval); });
    } catch (err: any) {
      send('error', { message: err?.message ?? String(err) });
      reply.raw.end();
    }
  });
}
