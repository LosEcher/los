import { getDb } from '@los/infra/db';
import type { TransactionClient } from './execution-persistence.js';
import type { VerificationRequirement } from './run-contract.js';

export type VerificationRecordStatus = 'required' | 'running' | 'succeeded' | 'failed' | 'skipped';

export interface VerificationRecord {
  id: string;
  sessionId: string;
  runSpecId?: string;
  taskRunId?: string;
  checkName: string;
  kind: VerificationRequirement['kind'];
  command?: string;
  assertion?: string;
  reviewer?: string;
  planRevision: number;
  status: VerificationRecordStatus;
  required: boolean;
  skipReason?: string;
  outputSummary?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

export interface CreateVerificationRecordInput {
  id: string;
  sessionId: string;
  runSpecId?: string;
  taskRunId?: string;
  checkName: string;
  kind?: VerificationRequirement['kind'];
  command?: string;
  assertion?: string;
  reviewer?: string;
  planRevision?: number;
  status?: VerificationRecordStatus;
  required?: boolean;
  skipReason?: string;
  outputSummary?: string;
  error?: string;
}

export interface UpdateVerificationRecordDetailsInput {
  skipReason?: string | null;
  outputSummary?: string;
  error?: string | null;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS verification_records (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  run_spec_id TEXT,
  task_run_id TEXT,
  check_name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'command',
  command TEXT,
  assertion TEXT,
  reviewer TEXT,
  plan_revision INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'required',
  required BOOLEAN NOT NULL DEFAULT true,
  skip_reason TEXT,
  output_summary TEXT,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ
);

ALTER TABLE verification_records ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'command';
ALTER TABLE verification_records ADD COLUMN IF NOT EXISTS assertion TEXT;
ALTER TABLE verification_records ADD COLUMN IF NOT EXISTS reviewer TEXT;
ALTER TABLE verification_records ADD COLUMN IF NOT EXISTS plan_revision INTEGER NOT NULL DEFAULT 1;

CREATE INDEX IF NOT EXISTS idx_verification_records_session ON verification_records(session_id);
CREATE INDEX IF NOT EXISTS idx_verification_records_run_spec ON verification_records(run_spec_id);
CREATE INDEX IF NOT EXISTS idx_verification_records_task_run ON verification_records(task_run_id);
CREATE INDEX IF NOT EXISTS idx_verification_records_status ON verification_records(status);
CREATE INDEX IF NOT EXISTS idx_verification_records_run_revision ON verification_records(run_spec_id, plan_revision, required);
`;

let _initialized = false;

export async function ensureVerificationRecordStore(): Promise<void> {
  if (_initialized) return;
  const db = getDb();
  await db.exec(SCHEMA);
  _initialized = true;
}

export async function createVerificationRecord(input: CreateVerificationRecordInput): Promise<VerificationRecord> {
  await ensureVerificationRecordStore();
  const db = getDb();
  const rows = await db.query<VerificationRecordRow>(
    `
    INSERT INTO verification_records (
      id, session_id, run_spec_id, task_run_id, check_name, kind, command, assertion,
      reviewer, plan_revision, status, required, skip_reason, output_summary, error, completed_at
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15,
      CASE WHEN $11 IN ('succeeded', 'failed', 'skipped') THEN now() ELSE NULL END
    )
    ON CONFLICT (id) DO UPDATE SET
      task_run_id = EXCLUDED.task_run_id,
      status = EXCLUDED.status,
      skip_reason = EXCLUDED.skip_reason,
      output_summary = EXCLUDED.output_summary,
      error = EXCLUDED.error,
      completed_at = EXCLUDED.completed_at,
      updated_at = now()
    WHERE verification_records.session_id = EXCLUDED.session_id
      AND verification_records.run_spec_id IS NOT DISTINCT FROM EXCLUDED.run_spec_id
      AND verification_records.check_name = EXCLUDED.check_name
      AND verification_records.plan_revision = EXCLUDED.plan_revision
    RETURNING *
  `,
    [
      input.id,
      input.sessionId,
      input.runSpecId ?? null,
      input.taskRunId ?? null,
      input.checkName,
      input.kind ?? 'command',
      input.command ?? null,
      input.assertion ?? null,
      input.reviewer ?? null,
      input.planRevision ?? 1,
      normalizeVerificationStatus(input.status),
      input.required ?? true,
      input.skipReason ?? null,
      input.outputSummary ?? null,
      input.error ?? null,
    ],
  );
  return rowToRecord(assertRow(rows.rows[0]));
}

export async function updateVerificationRecordDetails(
  id: string,
  input: UpdateVerificationRecordDetailsInput,
): Promise<VerificationRecord | null> {
  await ensureVerificationRecordStore();
  const rows = await getDb().query<VerificationRecordRow>(
    `UPDATE verification_records
     SET skip_reason = COALESCE($2, skip_reason),
         output_summary = COALESCE($3, output_summary),
         error = $4,
         updated_at = now()
     WHERE id = $1
     RETURNING *`,
    [id, input.skipReason ?? null, input.outputSummary ?? null, input.error ?? null],
  );
  return rows.rows[0] ? rowToRecord(rows.rows[0]) : null;
}

export async function loadVerificationRecord(id: string): Promise<VerificationRecord | null> {
  await ensureVerificationRecordStore();
  const db = getDb();
  const rows = await db.query<VerificationRecordRow>(
    'SELECT * FROM verification_records WHERE id = $1',
    [id],
  );
  return rows.rows[0] ? rowToRecord(rows.rows[0]) : null;
}

export async function listVerificationRecordsForRunSpec(
  runSpecId: string,
  options: { planRevision?: number } = {},
): Promise<VerificationRecord[]> {
  await ensureVerificationRecordStore();
  const db = getDb();
  const rows = await db.query<VerificationRecordRow>(
    `SELECT * FROM verification_records
     WHERE run_spec_id = $1
       AND ($2::integer IS NULL OR plan_revision = $2)
     ORDER BY created_at, id`,
    [runSpecId, options.planRevision ?? null],
  );
  return rows.rows.map(rowToRecord);
}

export async function listVerificationRecordsForSession(sessionId: string): Promise<VerificationRecord[]> {
  await ensureVerificationRecordStore();
  const db = getDb();
  const rows = await db.query<VerificationRecordRow>(
    'SELECT * FROM verification_records WHERE session_id = $1 ORDER BY created_at, id',
    [sessionId],
  );
  return rows.rows.map(rowToRecord);
}

export async function seedVerificationRequirementsForRunSpec(input: {
  runSpecId: string;
  sessionId: string;
  planRevision?: number;
  requiredChecks?: readonly string[];
  verifications?: readonly VerificationRequirement[];
}): Promise<VerificationRecord[]> {
  const planRevision = input.planRevision ?? 1;
  const checks = normalizeRequirements(input.requiredChecks, input.verifications);
  const out: VerificationRecord[] = [];
  for (let index = 0; index < checks.length; index += 1) {
    const requirement = checks[index]!;
    out.push(await createVerificationRecord({
      id: `verification-${input.runSpecId}-r${planRevision}-${index + 1}`,
      sessionId: input.sessionId,
      runSpecId: input.runSpecId,
      checkName: requirement.checkName,
      kind: requirement.kind,
      command: requirement.command,
      assertion: requirement.assertion,
      reviewer: requirement.reviewer,
      planRevision,
      status: 'required',
      required: true,
    }));
  }
  return out;
}

export async function replaceVerificationRequirementsForRunSpec(client: TransactionClient, input: {
  runSpecId: string;
  sessionId: string;
  planRevision: number;
  requiredChecks?: readonly string[];
  verifications?: readonly VerificationRequirement[];
}): Promise<void> {
  await client.query(
    'UPDATE verification_records SET required = FALSE, updated_at = now() WHERE run_spec_id = $1 AND required = TRUE',
    [input.runSpecId],
  );
  const requirements = normalizeRequirements(input.requiredChecks, input.verifications);
  for (const [index, requirement] of requirements.entries()) {
    await client.query(
      `INSERT INTO verification_records (
         id, session_id, run_spec_id, check_name, kind, command, assertion, reviewer,
         plan_revision, status, required
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'required', TRUE)`,
      [
        `verification-${input.runSpecId}-r${input.planRevision}-${index + 1}`,
        input.sessionId,
        input.runSpecId,
        requirement.checkName,
        requirement.kind,
        requirement.command ?? null,
        requirement.assertion ?? null,
        requirement.reviewer ?? null,
        input.planRevision,
      ],
    );
  }
}

type VerificationRecordRow = {
  id: string;
  session_id: string;
  run_spec_id: string | null;
  task_run_id: string | null;
  check_name: string;
  kind: string;
  command: string | null;
  assertion: string | null;
  reviewer: string | null;
  plan_revision: number;
  status: string;
  required: boolean;
  skip_reason: string | null;
  output_summary: string | null;
  error: string | null;
  created_at: Date | string;
  updated_at: Date | string;
  completed_at: Date | string | null;
};

function rowToRecord(row: VerificationRecordRow): VerificationRecord {
  return {
    id: row.id,
    sessionId: row.session_id,
    runSpecId: row.run_spec_id ?? undefined,
    taskRunId: row.task_run_id ?? undefined,
    checkName: row.check_name,
    kind: normalizeVerificationKind(row.kind),
    command: row.command ?? undefined,
    assertion: row.assertion ?? undefined,
    reviewer: row.reviewer ?? undefined,
    planRevision: row.plan_revision,
    status: normalizeVerificationStatus(row.status),
    required: row.required,
    skipReason: row.skip_reason ?? undefined,
    outputSummary: row.output_summary ?? undefined,
    error: row.error ?? undefined,
    createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at),
    completedAt: row.completed_at ? toIsoString(row.completed_at) : undefined,
  };
}

function normalizeVerificationStatus(value: unknown): VerificationRecordStatus {
  if (value === 'required' || value === 'running' || value === 'succeeded' || value === 'failed' || value === 'skipped') return value;
  return 'required';
}

function normalizeVerificationKind(value: unknown): VerificationRequirement['kind'] {
  if (value === 'assertion' || value === 'operator_review') return value;
  return 'command';
}

function normalizeRequirements(
  requiredChecks: readonly string[] | undefined,
  verifications: readonly VerificationRequirement[] | undefined,
): Array<{ checkName: string; kind: VerificationRequirement['kind']; command?: string; assertion?: string; reviewer?: string }> {
  const requirements = [
    ...uniqueStrings(requiredChecks ?? []).map((checkName) => ({ checkName, kind: 'command' as const, command: checkName })),
    ...(verifications ?? []).map((requirement) => ({
      checkName: requirement.id.trim(),
      kind: requirement.kind,
      command: requirement.command?.trim() || undefined,
      assertion: requirement.assertion?.trim() || undefined,
      reviewer: requirement.reviewer?.trim() || undefined,
    })),
  ].filter((requirement) => requirement.checkName);
  return [...new Map(requirements.map((requirement) => [requirement.checkName, requirement])).values()];
}

function uniqueStrings(value: readonly string[]): string[] {
  return [...new Set(value.map((item) => item.trim()).filter(Boolean))];
}

function toIsoString(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function assertRow<T>(row: T | undefined): T {
  if (!row) throw new Error('Failed to create verification record');
  return row;
}
