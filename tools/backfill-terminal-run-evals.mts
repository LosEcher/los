#!/usr/bin/env tsx
/**
 * Phase 2.1 — backfill terminal_projection run_evals for existing terminal runs.
 *
 * Usage (repo root, gateway/DB available):
 *   ./packages/gateway/node_modules/.bin/tsx tools/backfill-terminal-run-evals.mts
 *   ./packages/gateway/node_modules/.bin/tsx tools/backfill-terminal-run-evals.mts --days 30 --limit 500
 */
import { loadConfig } from '../packages/infra/src/config.ts';
import { initDb, closeDb, getDb } from '../packages/infra/src/db.ts';
import {
  recordTerminalRunEval,
  TERMINAL_RUN_STATUSES,
} from '../packages/agent/src/run-evals/terminal-projection.ts';

function argValue(flag: string): string | undefined {
  const idx = process.argv.indexOf(flag);
  if (idx < 0) return undefined;
  return process.argv[idx + 1];
}

async function main(): Promise<void> {
  const days = Math.max(1, Number(argValue('--days') ?? '90') || 90);
  const limit = Math.max(1, Math.min(5000, Number(argValue('--limit') ?? '1000') || 1000));
  const dryRun = process.argv.includes('--dry-run');

  const config = await loadConfig();
  await initDb(config.databaseUrl);
  const db = getDb();

  const rows = await db.query<{
    id: string;
    session_id: string;
    status: string;
    created_at: string;
  }>(
    `
    SELECT rs.id, rs.session_id, rs.status, rs.created_at::text
    FROM run_specs rs
    WHERE rs.status = ANY($1::text[])
      AND rs.id NOT IN ('eval-backlog', 'manual')
      AND rs.created_at >= now() - ($2::text || ' days')::interval
      AND NOT EXISTS (
        SELECT 1 FROM run_evals e
        WHERE e.run_spec_id = rs.id
          AND e.id = 'run-eval-terminal-' || rs.id
      )
    ORDER BY rs.created_at DESC
    LIMIT $3
    `,
    [[...TERMINAL_RUN_STATUSES], String(days), limit],
  );

  console.log(JSON.stringify({
    mode: dryRun ? 'dry-run' : 'write',
    days,
    limit,
    candidates: rows.rows.length,
  }));

  let ok = 0;
  let skipped = 0;
  let failed = 0;
  for (const row of rows.rows) {
    if (dryRun) {
      console.log(`dry-run ${row.id} status=${row.status}`);
      skipped += 1;
      continue;
    }
    try {
      const record = await recordTerminalRunEval({
        runSpecId: row.id,
        sessionId: row.session_id,
        status: row.status,
        reason: 'backfill_terminal_projection',
      });
      if (record) {
        ok += 1;
        console.log(`ok ${row.id} -> ${record.id} success=${record.success} class=${record.failureClass ?? '-'}`);
      } else {
        skipped += 1;
        console.log(`skip ${row.id}`);
      }
    } catch (error) {
      failed += 1;
      console.error(`fail ${row.id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const coverage = await db.query<{ terminal_runs: string; with_eval: string }>(
    `
    SELECT
      COUNT(*)::text AS terminal_runs,
      COUNT(*) FILTER (
        WHERE EXISTS (
          SELECT 1 FROM run_evals e
          WHERE e.run_spec_id = rs.id
            AND e.summary_json->>'kind' = 'terminal_projection'
        )
      )::text AS with_eval
    FROM run_specs rs
    WHERE rs.status = ANY($1::text[])
      AND rs.id NOT IN ('eval-backlog', 'manual')
    `,
    [[...TERMINAL_RUN_STATUSES]],
  );

  console.log(JSON.stringify({
    wrote: ok,
    skipped,
    failed,
    coverage: coverage.rows[0],
  }, null, 2));

  await closeDb();
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
