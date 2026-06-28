/**
 * tools/check-migration-drift.ts
 *
 * Authoritative schema-drift gate between the two sources of truth:
 *   - migrations (packages/infra/migrations/*.sql via migrateDir)
 *   - ensure*Store() runtime SCHEMAs (the real bootstrap the gateway uses)
 *
 * Method: bootstrap two fresh DBs — one via migrations only, one via
 * ensure*Store only — then structurally diff them (columns/types/defaults,
 * indexes, constraint definitions, functions, triggers). Any difference is
 * drift: a migration that diverges from what the runtime actually creates.
 *
 * Unlike a "migrate then ensure and check ensure is a no-op" gate, this
 * two-DB diff ALSO catches wrong defaults / wrong types / wrong column names /
 * wrong PK composition on columns a migration already creates (where ensure's
 * ADD COLUMN IF NOT EXISTS would silently no-op).
 *
 * Env:
 *   SERVER_URL  — connection to an existing DB on the target Postgres server,
 *                 used to issue DROP/CREATE DATABASE. The user must have
 *                 CREATEDB. (In CI, DATABASE_URL works — los is superuser.
 *                 Locally, point this at a superuser URL.)
 *   MIG_DB      — name for the migrations-only DB (default: los_drift_mig)
 *   ENSURE_DB   — name for the ensure-only DB     (default: los_drift_ensure)
 *
 * Exit 0 = no drift; exit 1 = drift found (prints the per-table diff).
 *
 * Run from packages/agent so tsx + workspace imports resolve:
 *   SERVER_URL=postgres://postgres:postgres@127.0.0.1:55432/postgres \
 *     node --import tsx ../../tools/check-migration-drift.ts
 */
import { initDb, getDb, closeDb } from '../packages/infra/src/db.js';
import { migrateDir } from '../packages/infra/src/migrate.js';
// Single source of truth for the ensure*Store set: import the canonical
// bootstrap function instead of re-listing all 32 ensure*Store here.
import { ensureAllStores } from '../packages/gateway/src/bootstrap.js';

const SERVER_URL = process.env.SERVER_URL ?? process.env.DATABASE_URL;
if (!SERVER_URL) { console.error('SERVER_URL (or DATABASE_URL) env required'); process.exit(2); }
const MIG_DB = process.env.MIG_DB ?? 'los_drift_mig';
const ENSURE_DB = process.env.ENSURE_DB ?? 'los_drift_ensure';
const MIG_DIR = new URL('../packages/infra/migrations/', import.meta.url).pathname;

// initDb()'s test guard (resolveDatabaseUrlForInit) ignores the explicit URL
// when NODE_ENV=test / TEST_DATABASE_URL is set, redirecting to the test DB.
// That would silently make this gate compare a DB against itself (always green,
// catches nothing). connect() asserts the connected DB matches the request so
// any such misroute fails LOUDLY instead of silently passing.
async function connect(url: string): Promise<void> {
  await initDb(url);
  const r = await getDb().query<{ d: string }>('SELECT current_database() AS d');
  const expected = new URL(url).pathname.replace(/^\/+/, '');
  const actual = r.rows[0].d;
  if (actual !== expected) {
    throw new Error(
      `DB misroute: requested "${expected}" but initDb connected to "${actual}". ` +
      `The test-DB guard (NODE_ENV=test / TEST_DATABASE_URL) is overriding the URL — ` +
      `unset NODE_ENV and TEST_DATABASE_URL for this gate (CI step sets env: {NODE_ENV: '', TEST_DATABASE_URL: ''}).`,
    );
  }
}

async function adminExec(sql: string): Promise<void> {
  await connect(SERVER_URL!);
  await getDb().exec(sql);
  await closeDb();
}

async function recreate(name: string): Promise<string> {
  await adminExec(`DROP DATABASE IF EXISTS "${name}"`);
  await adminExec(`CREATE DATABASE "${name}"`);
  const u = new URL(SERVER_URL!);
  u.pathname = '/' + name;
  return u.toString();
}

async function bootstrapMig(url: string): Promise<void> {
  await connect(url);
  const res = await migrateDir(MIG_DIR, getDb());
  await closeDb();
  if (res.errors.length) throw new Error('migrateDir errors: ' + res.errors.join('; '));
}

async function bootstrapEnsure(url: string): Promise<void> {
  await connect(url);
  await ensureAllStores();
  await closeDb();
}

// ── structural signatures ──
const COLS = `SELECT table_name||'|'||column_name||'|'||data_type||'|'||is_nullable||'|'||COALESCE(column_default,'')
  FROM information_schema.columns WHERE table_schema='public' ORDER BY table_name, column_name`;
const IDXS = `SELECT tablename||'|'||indexname||'|'||indexdef FROM pg_indexes WHERE schemaname='public' ORDER BY tablename, indexname`;
const CONS = `SELECT t||'|'||n||'|'||d FROM (SELECT conrelid::regclass::text AS t, conname AS n, pg_get_constraintdef(oid) AS d
  FROM pg_constraint WHERE connamespace='public'::regnamespace) s ORDER BY t,n`;
const FUNCS = `SELECT p.proname||'|'||pg_get_functiondef(p.oid)
  FROM pg_proc p JOIN pg_namespace n ON p.pronamespace=n.oid WHERE n.nspname='public' ORDER BY 1`;
const TRIGS = `SELECT tgname||'|'||pg_get_triggerdef(oid) FROM pg_trigger WHERE NOT tgisinternal ORDER BY 1`;

async function sig(url: string, query: string): Promise<string[]> {
  await connect(url);
  const r = await getDb().query<{ s: string }>(query);
  await closeDb();
  return r.rows.map((row: Record<string, unknown>) => Object.values(row)[0] as string);
}

function tableName(line: string): string {
  return line.split('|', 1)[0];
}

// Diff scoped to tables present in BOTH DBs (real migration-vs-ensure drift).
// Tables only in one DB are a coverage gap, handled separately.
// Returns the raw diff lines (for baseline comparison) for each check.
function diffShared(a: string[], b: string[], shared: Set<string>): string[] {
  const out: string[] = [];
  const sa = new Set(a), sb = new Set(b);
  for (const x of a) if (!sb.has(x) && shared.has(tableName(x))) out.push(`[mig-only]    ${x}`);
  for (const x of b) if (!sa.has(x) && shared.has(tableName(x))) out.push(`[ensure-only] ${x}`);
  return out;
}

async function tableSet(url: string): Promise<Set<string>> {
  const rows = await sig(url, `SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY 1`);
  return new Set(rows.map((r) => r.trim()));
}

const BASELINE_FILE = new URL('./migration-drift-baseline.txt', import.meta.url).pathname;
const UPDATE_BASELINE = process.argv.includes('--update-baseline');

async function main(): Promise<number> {
  const migUrl = await recreate(MIG_DB);
  const ensureUrl = await recreate(ENSURE_DB);

  let exitCode = 0;
  try {
    await bootstrapMig(migUrl);
    await bootstrapEnsure(ensureUrl);

    const migTables = await tableSet(migUrl);
    const ensureTables = await tableSet(ensureUrl);
    const shared = new Set([...migTables].filter((t) => ensureTables.has(t)));
    const ensureOnly = [...ensureTables].filter((t) => !migTables.has(t));
    const migOnly = [...migTables].filter((t) => !ensureTables.has(t));

    const checks: Array<[string, string]> = [
      ['COLUMNS', COLS], ['INDEXES', IDXS], ['CONSTRAINTS', CONS],
      ['FUNCTIONS', FUNCS], ['TRIGGERS', TRIGS],
    ];
    const rawDiffs: string[] = [];
    for (const [name, q] of checks) {
      // Sequential: initDb/closeDb use a shared global pool, can't run concurrently.
      const a = await sig(migUrl, q);
      const b = await sig(ensureUrl, q);
      for (const d of diffShared(a, b, shared)) rawDiffs.push(`${name}|${d}`);
    }
    rawDiffs.sort();

    // --update-baseline: (re)write the baseline to the current drift snapshot.
    if (UPDATE_BASELINE) {
      const { writeFileSync } = await import('node:fs');
      writeFileSync(BASELINE_FILE, rawDiffs.join('\n') + (rawDiffs.length ? '\n' : ''));
      console.log(`✅ Baseline written: ${rawDiffs.length} drift entries → ${BASELINE_FILE}`);
      return 0;
    }

    const lines: string[] = [];

    // Coverage: ensure*Store creates a table no migration creates → fresh
    // db:migrate would miss it. Always a failure (the PR #88 class).
    if (ensureOnly.length) {
      exitCode = 1;
      lines.push(`\n### ENSURE-ONLY TABLES (ensure*Store creates, no migration) — NEW FAIL`);
      for (const t of ensureOnly) lines.push(`  ${t}`);
    }
    if (migOnly.length) {
      lines.push(`\n### MIG-ONLY TABLES (migration-sourced, not cross-checked) — info`);
      for (const t of migOnly) lines.push(`  ${t}`);
    }

    // Baseline comparison: fail only on NEW drift (lines not in the baseline).
    // Existing drift is grandfathered until PR 3 cleans it up; as drift is
    // fixed, shrink the baseline via --update-baseline.
    let baseline = new Set<string>();
    try {
      const { readFileSync } = await import('node:fs');
      baseline = new Set(readFileSync(BASELINE_FILE, 'utf8').split('\n').filter(Boolean));
    } catch { /* no baseline yet → treat as empty (everything is new) */ }
    const newDrift = rawDiffs.filter((d) => !baseline.has(d));
    const removedDrift = [...baseline].filter((d) => !rawDiffs.includes(d));

    if (newDrift.length) {
      exitCode = 1;
      lines.push(`\n### NEW MIGRATION DRIFT (not in baseline) — FAIL (${newDrift.length})`);
      for (const d of newDrift) lines.push(`  ${d}`);
    }
    lines.push(`\n### drift summary: ${rawDiffs.length} current / ${baseline.size} baseline / ${newDrift.length} new / ${removedDrift.length} fixed`);

    if (exitCode) {
      console.error(`\n❌ NEW migration drift detected (${newDrift.length} new, ${ensureOnly.length} ensure-only tables).`);
      console.error(lines.join('\n'));
      console.error('\nFix: update the migration to match the ensure*Store SCHEMA, or add a new migration.');
      console.error('(Existing drift is grandfathered in tools/migration-drift-baseline.txt; shrink it with --update-baseline as you fix drift.)');
    } else {
      console.log(`✅ No NEW migration drift (${rawDiffs.length} grandfathered, ${removedDrift.length} fixed since baseline).`);
      if (removedDrift.length) console.log(`  ${removedDrift.length} drift entries fixed — run with --update-baseline to shrink the baseline.`);
      if (migOnly.length) console.log(`  (${migOnly.length} migration-sourced tables not cross-checked: ${migOnly.join(', ')})`);
    }
  } finally {
    // Close any pool left open by a failed bootstrap so adminExec's connect()
    // opens a fresh SERVER_URL pool (initDb returns the existing pool if set).
    try { await closeDb(); } catch { /* pool may already be closed */ }
    try {
      await adminExec(`DROP DATABASE IF EXISTS "${MIG_DB}"`);
      await adminExec(`DROP DATABASE IF EXISTS "${ENSURE_DB}"`);
    } catch { /* best-effort cleanup */ }
  }
  return exitCode;
}

main().then((c) => process.exit(c)).catch((e) => { console.error(e); process.exit(1); });
