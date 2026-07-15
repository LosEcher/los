import assert from 'node:assert/strict';
import test from 'node:test';

import { withDbClient } from '@los/infra/db';
import { ensureMemoryStore } from './core/store.js';

const DATASET_SIZES = [1_000, 10_000, 100_000] as const;
const MAX_EXECUTION_MS: Record<(typeof DATASET_SIZES)[number], number> = {
  1_000: 100,
  10_000: 200,
  100_000: 500,
};

interface ExplainNode {
  'Node Type': string;
  'Index Name'?: string;
  'Actual Rows'?: number;
  Plans?: ExplainNode[];
}

interface ExplainResult {
  Plan: ExplainNode;
  'Planning Time': number;
  'Execution Time': number;
}

interface FtsBenchmarkResult {
  rows: (typeof DATASET_SIZES)[number];
  planningMs: number;
  executionMs: number;
  actualRows: number;
  planNodes: string[];
  indexNames: string[];
}

test('observation FTS remains indexed through 100k rows', { timeout: 120_000 }, async (context) => {
  await ensureMemoryStore();

  const results = await withDbClient(async (client) => {
    await client.query('BEGIN');
    try {
      await client.query("SET LOCAL statement_timeout = '30s'");
      const measurements: FtsBenchmarkResult[] = [];
      let insertedRows = 0;

      for (const datasetSize of DATASET_SIZES) {
        await client.query(
          `INSERT INTO observations (
             title, summary, kind, tags_json, content, metadata_json, source,
             session_id, tenant_id, project_id
           )
           SELECT
             'FTS benchmark row ' || n,
             CASE WHEN n % 1000 = 0 THEN 'rare memory benchmark needle' ELSE 'common filler text' END,
             'benchmark',
             '["fts-benchmark"]'::jsonb,
             'deterministic benchmark content ' || n,
             '{"scope":"benchmark","memoryLayer":"semantic"}'::jsonb,
             'benchmark',
             'session-fts-benchmark',
             'tenant-fts-benchmark',
             'project-fts-benchmark'
           FROM generate_series($1::int, $2::int) AS series(n)`,
          [insertedRows + 1, datasetSize],
        );
        insertedRows = datasetSize;
        await client.query('ANALYZE observations');

        const explained = await client.query<{ 'QUERY PLAN': ExplainResult[] }>(
          `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
           SELECT *
           FROM observations
           WHERE search_vector @@ plainto_tsquery('simple', $1)
           ORDER BY ts_rank_cd(search_vector, plainto_tsquery('simple', $1)) DESC, created_at DESC
           LIMIT $2`,
          ['needle', 20],
        );
        const explainResult = explained.rows[0]?.['QUERY PLAN']?.[0];
        assert.ok(explainResult, `missing EXPLAIN result for ${datasetSize} rows`);
        const planNodes = flattenPlan(explainResult.Plan);
        measurements.push({
          rows: datasetSize,
          planningMs: explainResult['Planning Time'],
          executionMs: explainResult['Execution Time'],
          actualRows: explainResult.Plan['Actual Rows'] ?? 0,
          planNodes: planNodes.map(node => node['Node Type']),
          indexNames: planNodes.flatMap(node => node['Index Name'] ? [node['Index Name']] : []),
        });
      }

      return measurements;
    } finally {
      await client.query('ROLLBACK');
    }
  });

  for (const result of results) {
    assert.ok(result.actualRows > 0, `${result.rows} rows should return a matching observation`);
    assert.ok(
      result.executionMs <= MAX_EXECUTION_MS[result.rows],
      `${result.rows} row FTS took ${result.executionMs}ms, limit ${MAX_EXECUTION_MS[result.rows]}ms`,
    );
  }

  const largest = results.at(-1);
  assert.ok(largest, 'missing 100k benchmark result');
  assert.ok(
    largest.indexNames.includes('idx_obs_search'),
    `100k row FTS did not use idx_obs_search: ${largest.planNodes.join(' -> ')}`,
  );
  context.diagnostic(`memory FTS baseline: ${JSON.stringify(results)}`);
});

function flattenPlan(plan: ExplainNode): ExplainNode[] {
  return [plan, ...(plan.Plans ?? []).flatMap(flattenPlan)];
}
