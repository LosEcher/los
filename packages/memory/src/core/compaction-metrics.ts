/**
 * @los/memory/compaction/compaction-metrics — Compaction effect metrics.
 *
 * Estimates token savings and context-window fill after compaction.
 * Token estimation uses a conservative chars-per-token ratio for
 * mixed code/natural-language content. All computations are best-effort.
 */

import { getDb } from '@los/infra/db';

const CHARS_PER_TOKEN = 2.0;

export interface CompactionMetrics {
  preTokenEstimate: number;
  postTokenEstimate: number;
  tokenSavedCount: number;
  compactionRatio: number;
  charsPerToken: number;
  postCompactionFillPct?: number;
}

/**
 * Compute compaction metrics by comparing observation content sizes
 * before compaction against the compacted summary size.
 */
export async function computeCompactionMetrics(params: {
  sessionId: string;
  summary: Record<string, unknown>;
  observationCount: number;
  contextWindowTokens?: number;
}): Promise<CompactionMetrics | null> {
  const { sessionId, summary, observationCount, contextWindowTokens } = params;
  if (observationCount === 0) return null;

  try {
    const db = getDb();
    const sizeRows = await db.query<{ total_chars: string }>(
      `SELECT COALESCE(SUM(char_length(title) + char_length(coalesce(summary, '')) + char_length(coalesce(content, ''))), 0)::text AS total_chars
       FROM observations
       WHERE session_id = $1
         AND coalesce(metadata_json->>'archived', 'false') = 'false'`,
      [sessionId],
    );

    const preChars = Number(sizeRows.rows[0]?.total_chars ?? 0);
    const preTokens = Math.round(preChars / CHARS_PER_TOKEN);
    const postChars = JSON.stringify(summary).length;
    const postTokens = Math.round(postChars / CHARS_PER_TOKEN);
    const tokenSavedCount = Math.max(0, preTokens - postTokens);
    const rawRatio = preTokens > 0 ? postTokens / preTokens : 1;
    const compactionRatio = Number(Math.min(rawRatio, 1).toFixed(4));

    const metrics: CompactionMetrics = {
      preTokenEstimate: preTokens,
      postTokenEstimate: postTokens,
      tokenSavedCount,
      compactionRatio,
      charsPerToken: CHARS_PER_TOKEN,
    };

    if (contextWindowTokens && contextWindowTokens > 0) {
      metrics.postCompactionFillPct =
        Number(((postTokens / contextWindowTokens) * 100).toFixed(2));
    }

    return metrics;
  } catch {
    // Metrics are best-effort; failures must not block compaction
    return null;
  }
}
