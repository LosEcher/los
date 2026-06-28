import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMigrationDriftBaseline, runMigrationDriftAudit } from './governance-auditors-migration.js';

// Sample baseline lines — exact format from tools/check-migration-drift.ts diffShared:
// `CATEGORY|[dir] table|...` where [mig-only] has 4 trailing spaces, [ensure-only] has 1.
const SAMPLE = [
  // artifacts: COLUMNS drift in BOTH directions → P2 (silent-apply class)
  'COLUMNS|[ensure-only] artifacts|checksum|text|NO|', // ensure has col, mig doesn't (ensure-only: 1 space after ])
  'COLUMNS|[mig-only]    artifacts|stale_col|text|YES|', // mig has col, ensure doesn't (mig-only: 4 spaces after ])
  // mcp_servers: CONSTRAINT drift (wrong PK) → P1
  'CONSTRAINTS|[ensure-only] mcp_servers|mcp_servers_pkey|PRIMARY KEY (id, tenant_id, project_id)',
  'CONSTRAINTS|[mig-only]    mcp_servers|mcp_servers_pkey|PRIMARY KEY (id)',
  // sessions: INDEXES-only drift → P4
  'INDEXES|[ensure-only] sessions|idx_sessions_request_id|CREATE INDEX ... ON public.sessions USING btree (request_id)',
  'INDEXES|[ensure-only] sessions|idx_sessions_trace_id|CREATE INDEX ... ON public.sessions USING btree (trace_id)',
  // todos: COLUMNS one direction only (ensure-only) → P3
  'COLUMNS|[ensure-only] todos|depends_on_ids_json|jsonb|NO|\'[]\'::jsonb',
].join('\n');

test('parseMigrationDriftBaseline parses both direction paddings', () => {
  const entries = parseMigrationDriftBaseline(SAMPLE);
  assert.equal(entries.length, 7);
  const mig = entries.find((e) => e.direction === 'mig-only' && e.table === 'artifacts');
  const ens = entries.find((e) => e.direction === 'ensure-only' && e.table === 'artifacts');
  assert.ok(mig, 'mig-only artifacts line parsed');
  assert.ok(ens, 'ensure-only artifacts line parsed');
  assert.equal(mig?.category, 'COLUMNS');
  assert.equal(ens?.category, 'COLUMNS');
});

test('parseMigrationDriftBaseline groups by table with correct counts + priority', async () => {
  // runMigrationDriftAudit groups via groupByTable; verify via the audit using a temp file.
  const tmp = `${process.env.LOS_MIGRATION_DRIFT_BASELINE ?? ''}`;
  process.env.LOS_MIGRATION_DRIFT_BASELINE = '/tmp/los-mig-drift-test-baseline.txt';
  const { writeFileSync, rmSync } = await import('node:fs');
  writeFileSync(process.env.LOS_MIGRATION_DRIFT_BASELINE, SAMPLE);
  try {
    const summary = await runMigrationDriftAudit() as Record<string, unknown>;
    const tables = summary.tables as Array<Record<string, unknown>>;
    assert.equal(summary.fileMissing, false);
    assert.equal(tables.length, 4); // artifacts, mcp_servers, sessions, todos
    assert.equal(summary.totalDrift, 7);

    const byTable = new Map(tables.map((t) => [t.table as string, t]));
    assert.equal(byTable.get('mcp_servers')?.priority, 'P1', 'CONSTRAINT drift → P1');
    assert.equal(byTable.get('artifacts')?.priority, 'P2', 'COLUMNS both directions → P2');
    assert.equal(byTable.get('todos')?.priority, 'P3', 'COLUMNS one direction → P3');
    assert.equal(byTable.get('sessions')?.priority, 'P3', 'INDEXES-only → P3 (lowest)');

    // P1 sorts first
    assert.equal(tables[0].table, 'mcp_servers');
  } finally {
    rmSync(process.env.LOS_MIGRATION_DRIFT_BASELINE, { force: true });
    if (tmp) process.env.LOS_MIGRATION_DRIFT_BASELINE = tmp;
    else delete process.env.LOS_MIGRATION_DRIFT_BASELINE;
  }
});

test('parseMigrationDriftBaseline: empty input → no entries', () => {
  assert.deepEqual(parseMigrationDriftBaseline(''), []);
  assert.deepEqual(parseMigrationDriftBaseline('\n  \n'), []);
});

test('parseMigrationDriftBaseline: malformed lines skipped', () => {
  const bad = ['garbage line', '|no-category', 'COLUMNS|not-a-bracket table|x', 'COLUMNS|[weird] table|x'].join('\n');
  const entries = parseMigrationDriftBaseline(bad);
  // 'COLUMNS|[weird] table|x' has a bracket but invalid direction → skipped
  assert.equal(entries.length, 0);
});

test('runMigrationDriftAudit: missing file → fileMissing, no findings', async () => {
  const prev = process.env.LOS_MIGRATION_DRIFT_BASELINE;
  process.env.LOS_MIGRATION_DRIFT_BASELINE = '/tmp/los-mig-drift-DOES-NOT-EXIST-12345.txt';
  try {
    const summary = await runMigrationDriftAudit() as Record<string, unknown>;
    assert.equal(summary.fileMissing, true);
    assert.equal(summary.tableCount, 0);
    assert.equal(summary.totalDrift, 0);
    assert.deepEqual(summary.tables, []);
  } finally {
    if (prev) process.env.LOS_MIGRATION_DRIFT_BASELINE = prev;
    else delete process.env.LOS_MIGRATION_DRIFT_BASELINE;
  }
});

test('parseMigrationDriftBaseline: FUNCTIONS/TRIGGERS categories pass through', () => {
  const content = 'FUNCTIONS|[ensure-only] observations|touch_observations_updated_at|CREATE OR REPLACE FUNCTION...';
  const entries = parseMigrationDriftBaseline(content);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].category, 'FUNCTIONS');
  assert.equal(entries[0].table, 'observations');
});
