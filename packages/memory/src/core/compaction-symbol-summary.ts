/**
 * @los/memory/compaction/compaction-symbol-summary — Phase 4 symbol collection.
 *
 * Extracted from compaction.ts to keep it under the 600-line CI gate.
 * Collects symbolRefs from session observations and aggregates into
 * a deduplicated symbol→count map. Pure data accumulation — no pattern detection.
 */

import { getDb } from '@los/infra/db';

/**
 * Collect symbolRefs from session observations and aggregate into
 * a deduplicated symbol→count map.
 */
export async function collectSymbolSummary(
  db: ReturnType<typeof getDb>,
  sessionId: string,
): Promise<Map<string, { name: string; kind: string; file: string; count: number }> | null> {
  try {
    const rows = await db.query<{ symbol_data: unknown }>(
      `SELECT metadata_json->'symbolRefs' as symbol_data
       FROM observations
       WHERE session_id = $1
         AND metadata_json ? 'symbolRefs'
         AND coalesce(metadata_json->>'archived', 'false') = 'false'`,
      [sessionId],
    );

    const allSymbols = new Map<string, { name: string; kind: string; file: string; count: number }>();
    for (const row of rows.rows) {
      const refs = row.symbol_data as Array<{
        callId?: string;
        symbols?: Array<{ id: string; name: string; kind: string; file: string }>;
      }> | null;
      for (const ref of refs ?? []) {
        for (const sym of ref.symbols ?? []) {
          if (!sym.id) continue;
          const existing = allSymbols.get(sym.id);
          if (existing) {
            existing.count++;
          } else {
            allSymbols.set(sym.id, { name: sym.name, kind: sym.kind, file: sym.file, count: 1 });
          }
        }
      }
    }

    return allSymbols.size > 0 ? allSymbols : null;
  } catch {
    // Symbol collection is best-effort; failures must not block compaction
    return null;
  }
}
