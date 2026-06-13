import { getDb, withInitDb } from '@los/infra/db';

export interface StatusConstraintDefinition {
  tableName: 'task_runs' | 'run_specs';
  constraintName: string;
  legalStatuses: string[];
}

export interface StatusConstraintSnapshot {
  tableName: string;
  constraintName: string;
  tableExists: boolean;
  constraintExists: boolean;
  validated: boolean;
  invalidRowCount: number;
  legalStatuses: string[];
  readyToValidate: boolean;
}

export interface StatusConstraintReport {
  generatedAt: string;
  constraints: StatusConstraintSnapshot[];
}

export interface ValidateStatusConstraintsResult {
  validated: string[];
  skipped: string[];
  before: StatusConstraintReport;
  after: StatusConstraintReport;
}

type ConstraintRow = {
  table_name: string;
  constraint_name: string;
  convalidated: boolean;
};

type CountRow = {
  count: string;
};

const STATUS_CONSTRAINTS: StatusConstraintDefinition[] = [
  {
    tableName: 'task_runs',
    constraintName: 'task_runs_status_chk',
    legalStatuses: ['queued', 'running', 'succeeded', 'failed', 'cancelled', 'blocked'],
  },
  {
    tableName: 'run_specs',
    constraintName: 'run_specs_status_chk',
    legalStatuses: ['created', 'running', 'succeeded', 'failed', 'cancelled', 'blocked'],
  },
];

export async function readStatusConstraintReportWithDefaultDb(): Promise<StatusConstraintReport> {
  return withInitDb(() => readStatusConstraintReportFromOpenDb());
}

export async function validateStatusConstraintsWithDefaultDb(): Promise<ValidateStatusConstraintsResult> {
  return withInitDb(() => validateStatusConstraintsFromOpenDb());
}

export async function validateStatusConstraintsFromOpenDb(): Promise<ValidateStatusConstraintsResult> {
  const before = await readStatusConstraintReportFromOpenDb();
  const validated: string[] = [];
  const skipped: string[] = [];

  for (const item of before.constraints) {
    const label = `${item.tableName}.${item.constraintName}`;
    if (!item.tableExists) throw new Error(`Cannot validate missing table: ${item.tableName}`);
    if (!item.constraintExists) throw new Error(`Cannot validate missing constraint: ${label}`);
    if (item.invalidRowCount > 0) throw new Error(`Cannot validate dirty constraint: ${label} invalidRows=${item.invalidRowCount}`);
    if (item.validated) {
      skipped.push(label);
      continue;
    }
    await validateKnownStatusConstraint(item.tableName, item.constraintName);
    validated.push(label);
  }

  return {
    validated,
    skipped,
    before,
    after: await readStatusConstraintReportFromOpenDb(),
  };
}

export async function readStatusConstraintReportFromOpenDb(): Promise<StatusConstraintReport> {
  const db = getDb();
  const constraintRows = await db.query<ConstraintRow>(
    `
    SELECT c.relname AS table_name, con.conname AS constraint_name, con.convalidated
    FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND con.conname = ANY($1::text[])
    ORDER BY c.relname, con.conname
  `,
    [STATUS_CONSTRAINTS.map(item => item.constraintName)],
  );
  const constraintsByName = new Map(constraintRows.rows.map(row => [`${row.table_name}.${row.constraint_name}`, row]));

  const snapshots: StatusConstraintSnapshot[] = [];
  for (const definition of STATUS_CONSTRAINTS) {
    const tableExists = await relationExists(definition.tableName);
    const row = constraintsByName.get(`${definition.tableName}.${definition.constraintName}`);
    const invalidRowCount = tableExists ? await countInvalidStatuses(definition) : 0;
    snapshots.push({
      tableName: definition.tableName,
      constraintName: definition.constraintName,
      tableExists,
      constraintExists: Boolean(row),
      validated: row?.convalidated === true,
      invalidRowCount,
      legalStatuses: definition.legalStatuses,
      readyToValidate: tableExists && Boolean(row) && invalidRowCount === 0,
    });
  }

  return {
    generatedAt: new Date().toISOString(),
    constraints: snapshots,
  };
}

export function summarizeStatusConstraintReport(report: StatusConstraintReport): {
  missingTables: number;
  missingConstraints: number;
  unvalidatedConstraints: number;
  invalidRows: number;
  readyToValidate: number;
} {
  return {
    missingTables: report.constraints.filter(item => !item.tableExists).length,
    missingConstraints: report.constraints.filter(item => item.tableExists && !item.constraintExists).length,
    unvalidatedConstraints: report.constraints.filter(item => item.constraintExists && !item.validated).length,
    invalidRows: report.constraints.reduce((sum, item) => sum + item.invalidRowCount, 0),
    readyToValidate: report.constraints.filter(item => item.readyToValidate && !item.validated).length,
  };
}

async function relationExists(tableName: string): Promise<boolean> {
  const rows = await getDb().query<{ exists: boolean }>(
    'SELECT to_regclass($1) IS NOT NULL AS exists',
    [`public.${tableName}`],
  );
  return rows.rows[0]?.exists === true;
}

async function countInvalidStatuses(definition: StatusConstraintDefinition): Promise<number> {
  const sql = `
    SELECT COUNT(*)::text AS count
    FROM ${definition.tableName}
    WHERE status IS NOT NULL AND status <> ALL($1::text[])
  `;
  const rows = await getDb().query<CountRow>(sql, [definition.legalStatuses]);
  return Number(rows.rows[0]?.count ?? 0);
}

async function validateKnownStatusConstraint(tableName: string, constraintName: string): Promise<void> {
  const definition = STATUS_CONSTRAINTS.find(item => item.tableName === tableName && item.constraintName === constraintName);
  if (!definition) throw new Error(`Unknown status constraint: ${tableName}.${constraintName}`);
  // VALIDATE CONSTRAINT performs a full table scan with a SHARE UPDATE EXCLUSIVE lock
  // (blocks concurrent DDL but allows reads and writes). Callers must check
  // invalidRowCount === 0 first to ensure the scan finds no violations.
  await getDb().exec(`ALTER TABLE ${definition.tableName} VALIDATE CONSTRAINT ${definition.constraintName}`);
}
