import type { FastifyInstance } from 'fastify';
import { ensureRunSpecStore, loadRunSpec, listRunSpecs } from '@los/agent/run-specs';
import { ensureSessionEventStore, listSessionEventsSince } from '@los/agent/session-events';
import {
  ensureStreamCheckpointStore,
  listStreamCheckpointsSince,
} from '@los/agent/stream-checkpoints';
import {
  applyToolCallRecoveryTransitionForRunSpec,
  approveRunSpecPhase,
  cancelScheduledTask,
  readAgentTaskGraph,
  reviseRunSpecPlan,
  readRuntimeEvidenceGraph,
  readRunStateProjection,
  readToolCallRecoveryForRunSpec,
  runVerificationRecordsForRunSpec,
} from '@los/agent';
import {
  asRecord,
  normalizeOptionalString,
  normalizeNonNegativeInteger,
  normalizeBoundedInteger,
  normalizeOptionalNonNegativeInteger,
} from './server-helpers.js';

type StreamReplayItem =
  | { kind: 'stream'; id: number; eventType: string; turn: number; payload: Record<string, unknown>; createdAt: string }
  | { kind: 'event'; id: number; type: string; turn: number; payload: Record<string, unknown>; createdAt: string };

export function registerRunRoutes(app: FastifyInstance): void {
  app.get('/runs', async () => {
    await ensureRunSpecStore();
    return await listRunSpecs();
  });

  app.get('/runs/:id/events', async (req, reply) => {
    const { id } = req.params as { id: string };
    const query = req.query as { since?: string; limit?: string };
    const since = normalizeNonNegativeInteger(query.since, 0);
    const limit = normalizeBoundedInteger(query.limit, 200, 1, 10000);

    await ensureRunSpecStore();
    await ensureSessionEventStore();
    const runSpec = await loadRunSpec(id);
    if (!runSpec) return reply.status(404).send({ error: 'Not found' });

    const events = await listSessionEventsSince(runSpec.sessionId, since, limit);
    return {
      runSpecId: runSpec.id, sessionId: runSpec.sessionId, since,
      count: events.length, nextSince: events.at(-1)?.id ?? since, events,
    };
  });

  app.get('/runs/:id/stream', async (req, reply) => {
    const { id } = req.params as { id: string };
    const query = req.query as { since?: string; streamSince?: string; limit?: string };
    const since = normalizeNonNegativeInteger(query.since, 0);
    const streamSince = normalizeNonNegativeInteger(query.streamSince, 0);
    const limit = normalizeBoundedInteger(query.limit, 200, 1, 10000);

    await ensureRunSpecStore();
    await ensureSessionEventStore();
    await ensureStreamCheckpointStore();
    const runSpec = await loadRunSpec(id);
    if (!runSpec) return reply.status(404).send({ error: 'Not found' });

    const [streamItems, events] = await Promise.all([
      listStreamCheckpointsSince(runSpec.sessionId, streamSince, limit),
      listSessionEventsSince(runSpec.sessionId, since, limit),
    ]);

    // Merge by createdAt timestamp, interleaving stream checkpoints and session events
    const merged: Array<StreamReplayItem> = [];
    let si = 0;
    let ei = 0;
    while (si < streamItems.length && ei < events.length) {
      if (streamItems[si].createdAt <= events[ei].createdAt) {
        merged.push({ kind: 'stream', id: streamItems[si].id, eventType: streamItems[si].eventType, turn: streamItems[si].turn, payload: streamItems[si].payload, createdAt: streamItems[si].createdAt });
        si += 1;
      } else {
        merged.push({ kind: 'event', id: events[ei].id, type: events[ei].type, turn: events[ei].turn, payload: events[ei].payload, createdAt: events[ei].createdAt });
        ei += 1;
      }
    }
    while (si < streamItems.length) {
      merged.push({ kind: 'stream', id: streamItems[si].id, eventType: streamItems[si].eventType, turn: streamItems[si].turn, payload: streamItems[si].payload, createdAt: streamItems[si].createdAt });
      si += 1;
    }
    while (ei < events.length) {
      merged.push({ kind: 'event', id: events[ei].id, type: events[ei].type, turn: events[ei].turn, payload: events[ei].payload, createdAt: events[ei].createdAt });
      ei += 1;
    }

    return {
      runSpecId: runSpec.id,
      sessionId: runSpec.sessionId,
      since,
      streamSince,
      count: merged.length,
      nextSince: events.at(-1)?.id ?? since,
      nextStreamSince: streamItems.at(-1)?.id ?? streamSince,
      items: merged,
    };
  });

  app.get('/runs/:id/inspect', async (req, reply) => {
    const { id } = req.params as { id: string };
    const [graph, state] = await Promise.all([
      readRuntimeEvidenceGraph(id),
      readRunStateProjection(id),
    ]);
    if (!graph) return reply.status(404).send({ error: 'Not found' });
    return { ...graph, state };
  });

  app.get('/runs/:id/graph', async (req, reply) => {
    const { id } = req.params as { id: string };
    const graph = await readRuntimeEvidenceGraph(id);
    if (!graph) return reply.status(404).send({ error: 'Not found' });
    return {
      nodes: graph.nodes,
      edges: graph.edges,
      runSpecId: graph.runSpecId,
      sessionId: graph.sessionId,
    };
  });

  app.get('/runs/:id/state', async (req, reply) => {
    const { id } = req.params as { id: string };
    const state = await readRunStateProjection(id);
    if (!state) return reply.status(404).send({ error: 'Not found' });
    return state;
  });

  app.post('/runs/:id/recover', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = asRecord(req.body);
    const staleMs = normalizeOptionalNonNegativeInteger(body.staleMs);

    if (body.apply === true) {
      const action = body.intent === 'cancel' ? 'cancel' : 'operator_attention';
      return await applyToolCallRecoveryTransitionForRunSpec(id, {
        action,
        staleMs,
        reason: normalizeOptionalString(body.reason),
        actor: normalizeOptionalString(body.actor),
        cancelLiveTaskRun: action === 'cancel'
          ? (taskRunId, reason) => cancelScheduledTask(taskRunId, reason)
          : undefined,
      });
    }

    return await readToolCallRecoveryForRunSpec(id, {
      intent: body.intent === 'cancel' ? 'cancel' : 'recover',
      staleMs,
    });
  });

  app.post('/runs/:id/verify', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = asRecord(req.body);
    await ensureRunSpecStore();
    const runSpec = await loadRunSpec(id);
    if (!runSpec) return reply.status(404).send({ error: 'Not found' });
    return await runVerificationRecordsForRunSpec(id, {
      cwd: normalizeOptionalString(body.cwd),
      timeoutMs: normalizeOptionalNonNegativeInteger(body.timeoutMs),
      outputLimit: normalizeOptionalNonNegativeInteger(body.outputLimit),
      includeFailed: body.includeFailed === false ? false : undefined,
    });
  });

  app.post('/runs/:id/approve', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = asRecord(req.body);
    await ensureRunSpecStore();
    const runSpec = await loadRunSpec(id);
    if (!runSpec) return reply.status(404).send({ error: 'Not found' });

    try {
      const updated = await approveRunSpecPhase(id, {
        actor: normalizeOptionalString(body.actor),
        reason: normalizeOptionalString(body.reason),
      });
      return {
        runSpecId: id,
        phase: updated.runContract?.phase,
        previousPhase: updated.runContract?.previousPhase,
        phaseChangedAt: updated.runContract?.phaseChangedAt,
      };
    } catch (err: any) {
      return reply.status(400).send({
        error: 'approval_failed',
        message: err?.message ?? String(err),
      });
    }
  });

  app.post('/runs/:id/revise-plan', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = asRecord(req.body);
    await ensureRunSpecStore();
    const runSpec = await loadRunSpec(id);
    if (!runSpec) return reply.status(404).send({ error: 'Not found' });

    try {
      const updated = await reviseRunSpecPlan(id, {
        plan: Array.isArray(body.plan) ? body.plan as any : undefined,
        actor: normalizeOptionalString(body.actor),
        reason: normalizeOptionalString(body.reason),
      });
      return {
        runSpecId: id,
        planRevision: updated.runContract?.planRevision,
        previousRevision: (updated.runContract?.planRevision ?? 1) - 1,
        phase: updated.runContract?.phase,
        previousPhase: updated.runContract?.previousPhase,
      };
    } catch (err: any) {
      return reply.status(400).send({
        error: 'plan_revision_failed',
        message: err?.message ?? String(err),
      });
    }
  });

  app.get('/runs/:id', async (req) => {
    const { id } = req.params as { id: string };
    await ensureRunSpecStore();
    const runSpec = await loadRunSpec(id);
    if (!runSpec) return { error: 'Not found' };
    return runSpec;
  });

  app.get('/runs/:id/graph', async (req) => {
    const { id } = req.params as { id: string };
    const query = req.query as { requireVerifier?: string };
    return await readAgentTaskGraph(id, {
      requireVerifier: query.requireVerifier === 'true' ? true : query.requireVerifier === 'false' ? false : undefined,
    });
  });
}
