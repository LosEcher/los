/**
 * Global operator attention SSE endpoint.
 *
 * Streams tool.warned, tool.denied, operator_attention, session.blocked,
 * and session.error events across ALL sessions. Designed for wechat-bot,
 * telegram-bot, and external notification consumers that need to detect
 * operator-relevant events without knowing session IDs in advance.
 *
 * GET /operator/events/live
 */

import type { FastifyInstance } from 'fastify';
import { ensureSessionEventStore } from '@los/agent/session-events';
import { requireOperator } from '../../request-context.js';

type OperatorLiveClient = { reply: any; lastId: number; ended: boolean };

const liveClients = new Map<number, OperatorLiveClient>();
let clientSeq = 0;

function makeSend(reply: { raw: { write: (chunk: string) => boolean } }) {
  return (event: string, data: unknown, eventId?: number) => {
    if (eventId !== undefined) reply.raw.write(`id: ${eventId}\n`);
    reply.raw.write(`event: ${event}\n`);
    reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
  };
}

export function registerOperatorEvents(app: FastifyInstance): void {
  app.get('/operator/events/live', async (req, reply) => {
    // Operator consent gate: the live event stream carries operator attention
    // events across ALL sessions/tenants. Require operator privilege when auth
    // is enabled so an authenticated non-operator cannot subscribe to other
    // tenants' operator attention events.
    if (!(await requireOperator(req, reply))) return;

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

    const send = makeSend(reply);
    let lastId = since;
    let ended = false;

    const OPERATOR_TYPES = ['tool.warned', 'tool.denied', 'operator_attention', 'session.blocked', 'session.error'];

    const pollAndSend = async () => {
      if (ended) return;
      const db = (await import('@los/infra/db')).getDb();
      try {
        const rows = await db.query(
          `SELECT * FROM session_events WHERE id > $1 AND type = ANY($2) ORDER BY id ASC LIMIT 100`,
          [lastId, OPERATOR_TYPES],
        );
        for (const row of rows.rows) {
          send('session.event', {
            id: Number(row.id), sessionId: row.session_id, turn: Number(row.turn),
            type: row.type, source: row.source, toolName: row.tool_name ?? null,
            payload: typeof row.payload_json === 'string' ? JSON.parse(row.payload_json) : row.payload_json,
            createdAt: typeof row.created_at === 'string' ? row.created_at : (row.created_at as Date).toISOString(),
          }, Number(row.id));
          lastId = Number(row.id);
        }
      } catch { /* best-effort */ }
    };

    try {
      await pollAndSend();
      send('operator.ready', { lastEventId: lastId });

      const cid = ++clientSeq;
      liveClients.set(cid, { reply, lastId, ended: false });

      const interval = setInterval(async () => {
        try { await pollAndSend(); const c = liveClients.get(cid); if (c) c.lastId = lastId; }
        catch { liveClients.delete(cid); clearInterval(interval); reply.raw.end(); }
      }, 1000);

      req.raw.on('close', () => { ended = true; liveClients.delete(cid); clearInterval(interval); });
    } catch (err: any) {
      send('error', { message: err?.message ?? String(err) });
      reply.raw.end();
    }
  });
}
