/**
 * @los/agent/tools/sql-query — Read-only SQL query tool.
 *
 * Allows the agent to run SELECT queries against the los PostgreSQL database.
 * Safety: only SELECT allowed; DDL/DML/write operations are blocked.
 * Results are limited to prevent context overflow.
 *
 * Enabled via toolset: add "sql" to LOS_ENABLED_TOOLSETS.
 */

import { getDb } from '@los/infra/db';
import { getLogger } from '@los/infra/logger';
import type { ToolRegistry } from '../core/registry.js';

const log = getLogger('agent');

// ── Blocked patterns ────────────────────────────────────

// Block dangerous write/DDL/DCL operations. SET, SHOW, and DO are excluded
// because they commonly appear in string literals and column values in SELECT queries.
// The permissive stance on SET/SHOW is safe because the tool only runs SELECT/WITH queries.
const BLOCKED_KEYWORDS = /\b(DROP|DELETE|INSERT|UPDATE|ALTER|CREATE|TRUNCATE|GRANT|REVOKE|VACUUM|REINDEX|COPY|EXECUTE|CALL|LOCK|LISTEN|NOTIFY|UNLISTEN|DISCARD|PREPARE|DEALLOCATE|REASSIGN|REFRESH)\b/i;

const BLOCKED_SEQUENCES = ['--', '/*', '*/', ';', '\\'];

const MAX_ROWS_DEFAULT = 100;
const MAX_ROWS_LIMIT = 500;
const QUERY_TIMEOUT_MS = 10_000;
const MAX_RESULT_CHARS = 32_000;

export function registerSqlQueryTool(registry: ToolRegistry): void {
  registry.register('sql_query', async (rawArgs) => {
    const args = rawArgs as Record<string, unknown>;
    const sql = String(args.query ?? '').trim();

    if (!sql) return { content: '', error: 'query is required' };

    // ── Safety checks ────────────────────────────────────
    const upperSql = sql.toUpperCase();

    // Must start with SELECT or WITH (CTE)
    if (!upperSql.startsWith('SELECT') && !upperSql.startsWith('WITH')) {
      return { content: '', error: 'Only SELECT and WITH (CTE) queries are allowed' };
    }

    // Block dangerous keywords anywhere in the query
    if (BLOCKED_KEYWORDS.test(sql)) {
      const match = sql.match(BLOCKED_KEYWORDS);
      return { content: '', error: `Query contains blocked keyword: ${match?.[0] ?? 'unknown'}. Only SELECT queries are permitted.` };
    }

    // Block dangerous sequences (comment injection, statement chaining)
    for (const seq of BLOCKED_SEQUENCES) {
      if (sql.includes(seq)) {
        return { content: '', error: `Query contains blocked sequence: "${seq}"` };
      }
    }

    const maxRows = Math.min(
      Number(args.maxRows ?? MAX_ROWS_DEFAULT) || MAX_ROWS_DEFAULT,
      MAX_ROWS_LIMIT,
    );

    try {
      const db = getDb();
      const start = Date.now();

      // Wrap in subquery to safely apply LIMIT even when query already has one.
      // PostgreSQL allows only one LIMIT per SELECT; wrapping avoids syntax errors.
      const result = await db.query(`SELECT * FROM (${sql}) _los_limit_sub LIMIT ${maxRows}`);

      const elapsed = Date.now() - start;

      if (result.rows.length === 0) {
        return { content: `Query returned 0 rows (${elapsed}ms).` };
      }

      // Format as JSON for readability
      const formatted = JSON.stringify(result.rows.slice(0, maxRows), null, 2);
      let content = `${result.rows.length} row${result.rows.length !== 1 ? 's' : ''} (${elapsed}ms):\n\n${formatted}`;

      if (content.length > MAX_RESULT_CHARS) {
        content = content.slice(0, MAX_RESULT_CHARS)
          + `\n\n... [truncated at ${MAX_RESULT_CHARS} chars, ${result.rows.length} total rows]`;
      }

      return { content };
    } catch (err: any) {
      log.warn(`sql_query failed: ${err?.message ?? String(err)}`);
      return { content: '', error: `Query failed: ${err?.message ?? String(err)}` };
    }
  }, {
    type: 'function',
    function: {
      name: 'sql_query',
      description:
        'Run a read-only SQL SELECT query against the los database. ' +
        'Only SELECT and WITH (CTE) statements are allowed. ' +
        'INSERT, UPDATE, DELETE, DROP, CREATE, ALTER and other write operations are blocked. ' +
        'Results are limited (default 100 rows, max 500). ' +
        'Use this to inspect los data: sessions, task runs, memory, todos, work items, etc.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'SQL SELECT or WITH (CTE) query. Example: "SELECT * FROM task_runs WHERE status = \'failed\' ORDER BY created_at DESC"',
          },
          maxRows: {
            type: 'number',
            description: `Maximum rows to return. Default ${MAX_ROWS_DEFAULT}, max ${MAX_ROWS_LIMIT}.`,
          },
        },
        required: ['query'],
      },
    },
  }, {
    riskLevel: 'L0',
    permissions: ['db:read'],
    timeoutMs: QUERY_TIMEOUT_MS + 5_000,
    retryable: true,
    idempotent: true,
    costLevel: 'low',
    sideEffect: false,
    tags: ['db', 'read', 'sql'],
  });
}
