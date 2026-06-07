import type { FastifyInstance } from 'fastify';
import { ensureRunSpecStore, loadRunSpec, listRunSpecs } from '@los/agent/run-specs';
import { ensureSessionEventStore, listSessionEventsSince } from '@los/agent/session-events';
import {
  applyToolCallRecoveryTransitionForRunSpec,
  cancelScheduledTask,
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

  app.get('/runs/:id/inspect', async (req, reply) => {
    const { id } = req.params as { id: string };
    const [graph, state] = await Promise.all([
      readRuntimeEvidenceGraph(id),
      readRunStateProjection(id),
    ]);
    if (!graph) return reply.status(404).send({ error: 'Not found' });
    return { ...graph, state };
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

  app.get('/runs/:id', async (req) => {
    const { id } = req.params as { id: string };
    await ensureRunSpecStore();
    const runSpec = await loadRunSpec(id);
    if (!runSpec) return { error: 'Not found' };
    return runSpec;
  });
}
