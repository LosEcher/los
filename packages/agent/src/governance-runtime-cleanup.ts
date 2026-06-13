import { getDb, withInitDb } from '@los/infra/db';

export interface RuntimeCleanupOptions {
  staleMs?: number;
  now?: Date | string;
  limit?: number;
}

export interface RuntimeCleanupTaskRunSnapshot {
  id: string;
  sessionId: string;
  runSpecId?: string;
  dedupeKey?: string;
  status: string;
  provider?: string;
  model?: string;
  promptPreview?: string;
  createdAt: string;
  updatedAt: string;
}

export interface RuntimeCleanupRunSpecSnapshot {
  id: string;
  sessionId: string;
  status: string;
  provider?: string;
  model?: string;
  prompt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface RuntimeCleanupCandidate<T> {
  record: T;
  reason: string;
  ageMs?: number;
}

export interface RuntimeCleanupReport {
  dryRun: true;
  staleMs: number;
  generatedAt: string;
  taskRuns: {
    scanned: number;
    illegalStatus: Array<RuntimeCleanupCandidate<RuntimeCleanupTaskRunSnapshot>>;
    staleFixtureCandidates: Array<RuntimeCleanupCandidate<RuntimeCleanupTaskRunSnapshot>>;
  };
  runSpecs: {
    scanned: number;
    illegalStatus: Array<RuntimeCleanupCandidate<RuntimeCleanupRunSpecSnapshot>>;
    staleFixtureCandidates: Array<RuntimeCleanupCandidate<RuntimeCleanupRunSpecSnapshot>>;
  };
}

type TaskRunDbRow = {
  id: string;
  session_id: string;
  run_spec_id: string | null;
  dedupe_key: string | null;
  status: string;
  provider: string | null;
  model: string | null;
  prompt_preview: string | null;
  created_at: Date | string;
  updated_at: Date | string;
};

type RunSpecDbRow = {
  id: string;
  session_id: string;
  status: string;
  provider: string | null;
  model: string | null;
  prompt: string | null;
  created_at: Date | string;
  updated_at: Date | string;
};

const DEFAULT_STALE_MS = 24 * 60 * 60 * 1000;
const TASK_RUN_STATUSES = new Set(['queued', 'running', 'succeeded', 'failed', 'cancelled', 'blocked']);
const RUN_SPEC_STATUSES = new Set(['created', 'running', 'succeeded', 'failed', 'cancelled', 'blocked']);
const ACTIVE_TASK_RUN_STATUSES = new Set(['queued', 'running']);
const ACTIVE_RUN_SPEC_STATUSES = new Set(['created', 'running']);
const FIXTURE_PATTERN = /(^|[^a-z0-9])(fixture|smoke|test|verifier-failure|tool-recovery|session-smoke)([^a-z0-9]|$)/i;

export async function detectRuntimeCleanupWithDefaultDb(
  options: RuntimeCleanupOptions = {},
): Promise<RuntimeCleanupReport> {
  return withInitDb(() => detectRuntimeCleanupFromOpenDb(options));
}

export async function detectRuntimeCleanupFromOpenDb(
  options: RuntimeCleanupOptions = {},
): Promise<RuntimeCleanupReport> {
  const limit = normalizeLimit(options.limit);
  const db = getDb();
  const [taskRows, runRows] = await Promise.all([
    db.query<TaskRunDbRow>(
      `
      SELECT id, session_id, run_spec_id, dedupe_key, status, provider, model, prompt_preview, created_at, updated_at
      FROM task_runs
      WHERE status NOT IN ('queued', 'running', 'succeeded', 'failed', 'cancelled', 'blocked')
         OR status IN ('queued', 'running')
      ORDER BY updated_at DESC
      LIMIT $1
    `,
      [limit],
    ),
    db.query<RunSpecDbRow>(
      `
      SELECT id, session_id, status, provider, model, prompt, created_at, updated_at
      FROM run_specs
      WHERE status NOT IN ('created', 'running', 'succeeded', 'failed', 'cancelled', 'blocked')
         OR status IN ('created', 'running')
      ORDER BY updated_at DESC
      LIMIT $1
    `,
      [limit],
    ),
  ]);

  return detectRuntimeCleanup({
    taskRuns: taskRows.rows.map(rowToTaskRunSnapshot),
    runSpecs: runRows.rows.map(rowToRunSpecSnapshot),
    staleMs: options.staleMs,
    now: options.now,
  });
}

export function detectRuntimeCleanup(input: {
  taskRuns: RuntimeCleanupTaskRunSnapshot[];
  runSpecs: RuntimeCleanupRunSpecSnapshot[];
  staleMs?: number;
  now?: Date | string;
}): RuntimeCleanupReport {
  const staleMs = normalizeStaleMs(input.staleMs);
  const now = input.now ? new Date(input.now) : new Date();
  const generatedAt = now.toISOString();
  const taskIllegal: Array<RuntimeCleanupCandidate<RuntimeCleanupTaskRunSnapshot>> = [];
  const taskStale: Array<RuntimeCleanupCandidate<RuntimeCleanupTaskRunSnapshot>> = [];
  const runIllegal: Array<RuntimeCleanupCandidate<RuntimeCleanupRunSpecSnapshot>> = [];
  const runStale: Array<RuntimeCleanupCandidate<RuntimeCleanupRunSpecSnapshot>> = [];

  for (const task of input.taskRuns) {
    if (!TASK_RUN_STATUSES.has(task.status)) {
      taskIllegal.push({ record: task, reason: `illegal_task_run_status:${task.status}` });
      continue;
    }
    const stale = ageMs(task.updatedAt, now);
    const fixtureReason = taskFixtureReason(task);
    if (ACTIVE_TASK_RUN_STATUSES.has(task.status) && stale >= staleMs && fixtureReason) {
      taskStale.push({ record: task, reason: fixtureReason, ageMs: stale });
    }
  }

  for (const run of input.runSpecs) {
    if (!RUN_SPEC_STATUSES.has(run.status)) {
      runIllegal.push({ record: run, reason: `illegal_run_spec_status:${run.status}` });
      continue;
    }
    const stale = ageMs(run.updatedAt, now);
    const fixtureReason = runSpecFixtureReason(run);
    if (ACTIVE_RUN_SPEC_STATUSES.has(run.status) && stale >= staleMs && fixtureReason) {
      runStale.push({ record: run, reason: fixtureReason, ageMs: stale });
    }
  }

  return {
    dryRun: true,
    staleMs,
    generatedAt,
    taskRuns: {
      scanned: input.taskRuns.length,
      illegalStatus: taskIllegal,
      staleFixtureCandidates: sortCandidates(taskStale),
    },
    runSpecs: {
      scanned: input.runSpecs.length,
      illegalStatus: runIllegal,
      staleFixtureCandidates: sortCandidates(runStale),
    },
  };
}

function taskFixtureReason(task: RuntimeCleanupTaskRunSnapshot): string | undefined {
  if (task.sessionId === 'session-1' && !task.runSpecId) return 'legacy_session_1_without_run_spec';
  return fixtureReason([
    task.id,
    task.sessionId,
    task.runSpecId,
    task.dedupeKey,
    task.promptPreview,
  ]);
}

function runSpecFixtureReason(run: RuntimeCleanupRunSpecSnapshot): string | undefined {
  return fixtureReason([
    run.id,
    run.sessionId,
    run.prompt,
  ]);
}

function fixtureReason(values: Array<string | undefined>): string | undefined {
  const haystack = values.filter(Boolean).join(' ');
  const match = FIXTURE_PATTERN.exec(haystack);
  return match ? `fixture_pattern:${match[2].toLowerCase()}` : undefined;
}

function rowToTaskRunSnapshot(row: TaskRunDbRow): RuntimeCleanupTaskRunSnapshot {
  return {
    id: row.id,
    sessionId: row.session_id,
    runSpecId: row.run_spec_id ?? undefined,
    dedupeKey: row.dedupe_key ?? undefined,
    status: row.status,
    provider: row.provider ?? undefined,
    model: row.model ?? undefined,
    promptPreview: row.prompt_preview ?? undefined,
    createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at),
  };
}

function rowToRunSpecSnapshot(row: RunSpecDbRow): RuntimeCleanupRunSpecSnapshot {
  return {
    id: row.id,
    sessionId: row.session_id,
    status: row.status,
    provider: row.provider ?? undefined,
    model: row.model ?? undefined,
    prompt: row.prompt ?? undefined,
    createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at),
  };
}

function sortCandidates<T extends { id: string }>(items: Array<RuntimeCleanupCandidate<T>>): Array<RuntimeCleanupCandidate<T>> {
  return items.sort((a, b) => a.record.id.localeCompare(b.record.id));
}

function ageMs(updatedAt: string, now: Date): number {
  const value = new Date(updatedAt).getTime();
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, now.getTime() - value);
}

function normalizeStaleMs(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_STALE_MS;
  return Math.max(60_000, Math.floor(value));
}

function normalizeLimit(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 500;
  return Math.max(1, Math.min(2000, Math.floor(value)));
}

function toIsoString(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
