/**
 * Governance auditor — ai_code_fix.
 *
 * Scans P1 governance todos (source `ga_loop` | `governance_sweep`, status
 * `backlog`) that the AI fix loop can pick up. Runs a reaper first to return
 * stale `in_progress` claims (lease expired) back to `backlog` so abandoned
 * fixes are re-attempted.
 *
 * This auditor only COUNTS candidates; the actual fix runs in `applyAICodeFix`
 * (ga-ai-code-fix.ts), which claims one todo, runs an AI agent to edit code,
 * verifies, and opens a PR.
 */
import { getDb } from '@los/infra/db';
import { getLogger } from '@los/infra/logger';
import type { GovernanceJob } from './governance-jobs-types.js';

const log = getLogger('governance-jobs');

/** Governance todo sources the AI fix loop is allowed to consume. */
export const AI_CODE_FIX_SOURCES = ['ga_loop', 'governance_sweep'] as const;

/**
 * Return stale AI-fix claims (lease expired) back to `backlog` so the next
 * sweep re-attempts them. Safe to run on every audit — only touches rows with
 * an `aiFixClaim.leaseExpiresAt` in the past.
 */
export async function reapStaleAICodeFixClaims(): Promise<number> {
  const db = getDb();
  const res = await db.query(
    `UPDATE todos
       SET status = 'backlog',
           updated_at = now(),
           metadata_json = metadata_json
             || jsonb_build_object('aiFixClaim',
                  jsonb_build_object('reapedAt', now()::text))
     WHERE status = 'in_progress'
       AND source = ANY($1::text[])
       AND metadata_json->'aiFixClaim'->>'leaseExpiresAt' IS NOT NULL
       AND (metadata_json->'aiFixClaim'->>'leaseExpiresAt')::timestamptz < now()
     RETURNING id`,
    [[...AI_CODE_FIX_SOURCES]],
  );
  const count = res.rows.length;
  if (count > 0) log.info(`AI code-fix reaper: returned ${count} stale claim(s) to backlog`);
  return count;
}

export async function runAICodeFixAudit(_job: GovernanceJob): Promise<Record<string, unknown>> {
  // Reaper: never let a crashed claim block a todo permanently.
  try {
    await reapStaleAICodeFixClaims();
  } catch (err) {
    log.warn(`AI code-fix reaper failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
  }

  const db = getDb();
  const res = await db.query<{
    id: string;
    title: string;
    description: string | null;
    priority: string;
    source: string;
    metadata_json: unknown;
  }>(
    `SELECT id, title, description, priority, source, metadata_json
     FROM todos
     WHERE priority = 'P1'
       AND status = 'backlog'
       AND source = ANY($1::text[])
       AND archived_at IS NULL
     ORDER BY updated_at ASC
     LIMIT 50`,
    [[...AI_CODE_FIX_SOURCES]],
  );

  const todos = res.rows.map(r => ({ id: r.id, title: r.title, source: r.source }));
  return {
    auditedAt: new Date().toISOString(),
    candidateCount: res.rows.length,
    nextTodoId: res.rows[0]?.id ?? null,
    todos,
  };
}
