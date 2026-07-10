import { loadConfig } from '@los/infra/config';
import { initDb, closeDb, getDb } from '@los/infra/db';

async function main() {
  const c = await loadConfig();
  await initDb(c.databaseUrl);
  const db = getDb();
  const r = await db.query<{
    id: number;
    session_id: string;
    type: string;
    tool_name: string | null;
    payload_json: unknown;
    created_at: string;
  }>(`
    SELECT id, session_id, type, tool_name, payload_json, created_at
    FROM session_events
    WHERE type = ANY($1)
       OR (tool_name IS NOT NULL AND tool_name = 'run_shell')
       OR payload_json::text ILIKE '%run_shell%'
       OR payload_json::text ILIKE '%L2 exceeds%'
    ORDER BY id DESC
    LIMIT 20
  `, [[
    'tool.warned',
    'tool.denied',
    'operator_attention',
    'run.operator_attention_required',
    'session.blocked',
  ]]);
  for (const row of r.rows) {
    const p = typeof row.payload_json === 'string'
      ? row.payload_json
      : JSON.stringify(row.payload_json ?? {});
    console.log([
      row.created_at,
      row.session_id,
      row.type,
      row.tool_name ?? '-',
      p.slice(0, 160).replace(/\n/g, ' '),
    ].join(' | '));
  }
  await closeDb().catch(() => undefined);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
