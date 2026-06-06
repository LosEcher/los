import { getDb } from '@los/infra/db';

export type VerificationRecordStatus = 'required' | 'running' | 'succeeded' | 'failed' | 'skipped';

export interface VerificationRecord {
  id: string;
  sessionId: string;
  runSpecId?: string;
  taskRunId?: string;
  checkName: string;
  command?: string;
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
  command?: string;
  status?: VerificationRecordStatus;
  required?: boolean;
  skipReason?: string;
  outputSummary?: string;
  error?: string;
}

export interface UpdateVerificationRecordInput {
  status: VerificationRecordStatus;
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
  command TEXT,
  status TEXT NOT NULL DEFAULT 'required',
  required BOOLEAN NOT NULL DEFAULT true,
  skip_reason TEXT,
  output_summary TEXT,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_verification_records_session ON verification_records(session_id);
CREATE INDEX IF NOT EXISTS idx_verification_records_run_spec ON verification_records(run_spec_id);
CREATE INDEX IF NOT EXISTS idx_verification_records_task_run ON verification_records(task_run_id);
CREATE INDEX IF NOT EXISTS idx_verification_records_status ON verification_records(status);
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
      id, session_id, run_spec_id, task_run_id, check_name, command, status,
      required, skip_reason, output_summary, error, completed_at
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
      CASE WHEN $7 IN ('succeeded', 'failed', 'skipped') THEN now() ELSE NULL END
    )
    ON CONFLICT (id) DO UPDATE SET
      session_id = EXCLUDED.session_id,
      run_spec_id = EXCLUDED.run_spec_id,
      task_run_id = EXCLUDED.task_run_id,
      check_name = EXCLUDED.check_name,
      command = EXCLUDED.command,
      status = EXCLUDED.status,
      required = EXCLUDED.required,
      skip_reason = EXCLUDED.skip_reason,
      output_summary = EXCLUDED.output_summary,
      error = EXCLUDED.error,
      completed_at = EXCLUDED.completed_at,
      updated_at = now()
    RETURNING *
  `,
    [
      input.id,
      input.sessionId,
      input.runSpecId ?? null,
      input.taskRunId ?? null,
      input.checkName,
      input.command ?? null,
      normalizeVerificationStatus(input.status),
      input.required ?? true,
      input.skipReason ?? null,
      input.outputSummary ?? null,
      input.error ?? null,
    ],
  );
  return rowToRecord(assertRow(rows.rows[0]));
}

export async function updateVerificationRecord(
  id: string,
  input: UpdateVerificationRecordInput,
): Promise<VerificationRecord | null> {
  await ensureVerificationRecordStore();
  const db = getDb();
  const status = normalizeVerificationStatus(input.status);
  const rows = await db.query<VerificationRecordRow>(
    `
    UPDATE verification_records
    SET status = $2,
        skip_reason = $3,
        output_summary = COALESCE($4, output_summary),
        error = $5,
        completed_at = CASE
          WHEN $2 IN ('succeeded', 'failed', 'skipped') THEN now()
          WHEN $2 IN ('required', 'running') THEN NULL
          ELSE completed_at
        END,
        updated_at = now()
    WHERE id = $1
    RETURNING *
  `,
    [id, status, input.skipReason ?? null, input.outputSummary ?? null, input.error ?? null],
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

export async function listVerificationRecordsForRunSpec(runSpecId: string): Promise<VerificationRecord[]> {
  await ensureVerificationRecordStore();
  const db = getDb();
  const rows = await db.query<VerificationRecordRow>(
    'SELECT * FROM verification_records WHERE run_spec_id = $1 ORDER BY created_at, id',
    [runSpecId],
  );
  return rows.rows.map(rowToRecord);
}

export async function seedVerificationRequirementsForRunSpec(input: {
  runSpecId: string;
  sessionId: string;
  requiredChecks?: readonly string[];
}): Promise<VerificationRecord[]> {
  const checks = uniqueStrings(input.requiredChecks ?? []);
  const out: VerificationRecord[] = [];
  for (let index = 0; index < checks.length; index += 1) {
    const checkName = checks[index]!;
    out.push(await createVerificationRecord({
      id: `verification-${input.runSpecId}-${index + 1}`,
      sessionId: input.sessionId,
      runSpecId: input.runSpecId,
      checkName,
      command: checkName,
      status: 'required',
      required: true,
    }));
  }
  return out;
}

type VerificationRecordRow = {
  id: string;
  session_id: string;
  run_spec_id: string | null;
  task_run_id: string | null;
  check_name: string;
  command: string | null;
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
    command: row.command ?? undefined,
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
