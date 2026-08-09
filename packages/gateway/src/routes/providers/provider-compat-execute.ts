/**
 * Gateway one-click provider compatibility execute.
 *
 * Design: configure-surface P0-3 / PR4.
 * - Operator-only
 * - Uses @los/agent compat-harness (createCompatibilityRunSpecs + summarize)
 * - Runs in-process via runScheduledAgentTask (same path as chat), NOT CLI HTTP
 * - Writes provider_compat_evidence; returns sanitized summary
 */

import { resolve, relative, isAbsolute } from 'node:path';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  createCompatibilityRunSpecs,
  selectCompatibilityProbes,
  summarizeCompatibilityEvents,
  target as compatTarget,
  type CompatibilityRunSpec,
  type CompatibilityRunSummary,
  type CompatibilitySseEvent,
} from '@los/agent/compat-harness';
import {
  listSessionEvents,
  recordProviderCompatEvidenceFromSummary,
  runScheduledAgentTask,
  type ScheduledAgentTaskResult,
} from '@los/agent';
import { asRecord, normalizeOptionalString } from '../server-helpers.js';
import { requireOperator } from '../../request-context.js';
import { sanitizeProviderCompatSummary } from './provider-helpers.js';

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 300_000;
const DEFAULT_PROBE = 'read-context';

export type CompatExecuteDependencies = {
  runScheduledAgentTask: typeof runScheduledAgentTask;
  listSessionEvents: typeof listSessionEvents;
  recordProviderCompatEvidenceFromSummary: typeof recordProviderCompatEvidenceFromSummary;
  resolveWorkspaceRoot: (requested: string | undefined) => string;
  nowMs: () => number;
};

const defaultDependencies: CompatExecuteDependencies = {
  runScheduledAgentTask,
  listSessionEvents,
  recordProviderCompatEvidenceFromSummary,
  resolveWorkspaceRoot: resolveCompatWorkspaceRoot,
  nowMs: () => Date.now(),
};

function resolveCompatWorkspaceRoot(requested: string | undefined): string {
  const base = process.cwd();
  if (!requested || !requested.trim()) return base;
  const resolved = isAbsolute(requested) ? resolve(requested) : resolve(base, requested);
  const rel = relative(base, resolved);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`workspaceRoot must stay under gateway workspace (${base})`);
  }
  return resolved;
}

function clampCompatTimeoutMs(raw: unknown): number {
  if (raw === undefined || raw === null || raw === '') return DEFAULT_TIMEOUT_MS;
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_TIMEOUT_MS;
  return Math.min(MAX_TIMEOUT_MS, Math.max(1_000, Math.floor(n)));
}

function buildCompatCliEquivalent(provider: string, model: string | undefined, probeId: string): string {
  const target = model ? `${provider}:${model}` : provider;
  return `los compat --execute --target ${target} --probe ${probeId}`;
}

async function executeProviderCompat(
  input: {
    provider: string;
    model?: string;
    probeId?: string;
    timeoutMs?: number;
    workspaceRoot?: string;
  },
  deps: CompatExecuteDependencies = defaultDependencies,
): Promise<{
  ok: boolean;
  evidenceId?: string;
  summary: CompatibilityRunSummary;
  cliEquivalent: string;
  elapsedMs: number;
}> {
  const provider = normalizeOptionalString(input.provider);
  if (!provider) throw new Error('provider is required');

  const model = normalizeOptionalString(input.model);
  const probeId = normalizeOptionalString(input.probeId) ?? DEFAULT_PROBE;
  const probes = selectCompatibilityProbes([probeId]);
  const workspaceRoot = deps.resolveWorkspaceRoot(input.workspaceRoot);
  const timeoutMs = clampCompatTimeoutMs(input.timeoutMs);
  const specs = createCompatibilityRunSpecs({
    targets: [compatTarget(provider, model)],
    probes,
    workspaceRoot,
    tracePrefix: `compat-web:${provider}`,
    dedupePrefix: `compat-web:${provider}`,
    maxLoops: probes[0]?.maxLoops,
  });
  const spec = specs[0];
  if (!spec) throw new Error('failed to build compatibility run spec');

  const started = deps.nowMs();
  const summary = await runOneCompatSpec(spec, timeoutMs, deps);
  const elapsedMs = deps.nowMs() - started;

  let evidenceId: string | undefined;
  try {
    const evidence = await deps.recordProviderCompatEvidenceFromSummary(summary);
    evidenceId = evidence.id;
  } catch {
    // Evidence write is best-effort for the HTTP response; summary still returned.
  }

  return {
    ok: summary.passed,
    evidenceId,
    summary,
    cliEquivalent: buildCompatCliEquivalent(provider, model, probeId),
    elapsedMs,
  };
}

async function runOneCompatSpec(
  spec: CompatibilityRunSpec,
  timeoutMs: number,
  deps: CompatExecuteDependencies,
): Promise<CompatibilityRunSummary> {
  let scheduled: ScheduledAgentTaskResult;
  try {
    scheduled = await deps.runScheduledAgentTask({
      prompt: spec.request.prompt,
      provider: spec.request.provider,
      model: spec.request.model,
      toolMode: spec.request.toolMode,
      maxLoops: spec.request.maxLoops,
      workspaceRoot: spec.request.workspaceRoot,
      timeoutMs,
      traceId: spec.request.traceId,
      dedupeKey: spec.request.dedupeKey
        ? `${spec.request.dedupeKey}:${deps.nowMs()}`
        : undefined,
      metadata: {
        compatProbe: true,
        probeId: spec.probe.id,
        targetLabel: spec.target.label,
      },
    });
  } catch (error) {
    return summarizeCompatibilityEvents(spec, [{
      event: 'error',
      data: { message: error instanceof Error ? error.message : String(error) },
    }]);
  }

  const sessionId = scheduled.sessionId;
  const events = await loadCompatEvents(sessionId, scheduled, deps);
  const summary = summarizeCompatibilityEvents(spec, events);

  if (!summary.sessionId) summary.sessionId = sessionId;
  if (!summary.taskRunId && 'taskRun' in scheduled) summary.taskRunId = scheduled.taskRun.id;
  if (scheduled.status !== 'completed' && !summary.error) {
    const reason = 'reason' in scheduled ? String(scheduled.reason) : scheduled.status;
    summary.error = summary.error ?? `compat run status=${scheduled.status}: ${reason}`;
    summary.failures = [...new Set([...summary.failures, summary.error])];
    summary.passed = false;
  }
  return summary;
}

async function loadCompatEvents(
  sessionId: string,
  scheduled: ScheduledAgentTaskResult,
  deps: CompatExecuteDependencies,
): Promise<CompatibilitySseEvent[]> {
  try {
    const rows = await deps.listSessionEvents(sessionId, 1000);
    if (rows.length > 0) {
      return rows.map(row => ({
        event: row.type,
        data: {
          type: row.type,
          sessionId: row.sessionId,
          toolName: row.toolName,
          payload: row.payload,
          usage: row.usage,
          message: typeof row.payload?.message === 'string' ? row.payload.message : undefined,
          taskRunId: 'taskRun' in scheduled ? scheduled.taskRun.id : undefined,
        },
      }));
    }
  } catch {
    // fall through to synthetic events
  }

  const events: CompatibilitySseEvent[] = [
    { event: 'session.started', data: { sessionId, payload: {} } },
  ];
  if (scheduled.status === 'completed') {
    events.push({ event: 'session.completed', data: { sessionId } });
    events.push({ event: 'done', data: { sessionId } });
  } else if (scheduled.status === 'cancelled') {
    events.push({ event: 'cancelled', data: { sessionId, message: scheduled.reason } });
  } else {
    const reason = 'reason' in scheduled ? String(scheduled.reason) : scheduled.status;
    events.push({ event: 'error', data: { sessionId, message: reason } });
  }
  return events;
}

function sanitizeExecuteResponse(result: Awaited<ReturnType<typeof executeProviderCompat>>) {
  return {
    ok: result.ok,
    evidenceId: result.evidenceId ?? null,
    elapsedMs: result.elapsedMs,
    cliEquivalent: result.cliEquivalent,
    summary: {
      specId: result.summary.specId,
      provider: result.summary.provider,
      model: result.summary.model ?? null,
      probeId: result.summary.probeId,
      sessionId: result.summary.sessionId ?? null,
      taskRunId: result.summary.taskRunId ?? null,
      runSpecId: result.summary.runSpecId ?? null,
      totalTokens: result.summary.totalTokens,
      completed: result.summary.completed,
      cancelled: result.summary.cancelled,
      passed: result.summary.passed,
      error: result.summary.error ?? null,
      failures: result.summary.failures,
      ...sanitizeProviderCompatSummary(result.summary as unknown as Record<string, unknown>),
    },
  };
}

async function handleCompatExecute(req: FastifyRequest, reply: FastifyReply, deps: CompatExecuteDependencies) {
  if (!(await requireOperator(req, reply))) return;
  const params = req.params as { name?: string };
  const body = asRecord(req.body);
  const provider = normalizeOptionalString(params.name);
  if (!provider) return reply.status(400).send({ error: 'provider name is required' });

  try {
    const result = await executeProviderCompat({
      provider,
      model: normalizeOptionalString(body.model),
      probeId: normalizeOptionalString(body.probe) ?? normalizeOptionalString(body.probeId),
      timeoutMs: clampCompatTimeoutMs(body.timeoutMs),
      workspaceRoot: normalizeOptionalString(body.workspaceRoot),
    }, deps);
    return sanitizeExecuteResponse(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status = /workspaceRoot|Unknown compatibility probe|provider is required/i.test(message) ? 422 : 500;
    return reply.status(status).send({ error: message });
  }
}

export function registerProviderCompatExecuteRoutes(
  app: FastifyInstance,
  dependencies: CompatExecuteDependencies = defaultDependencies,
): void {
  app.post('/providers/:name/compat/execute', (req, reply) => handleCompatExecute(req, reply, dependencies));
}
