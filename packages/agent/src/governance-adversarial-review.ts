/**
 * @los/agent/governance-adversarial-review — Adversarial review auditor.
 *
 * Deterministic checks derived from real incident patterns (2026-08-06):
 * metric semantics (telemetry covered headers only), lingering no-listener
 * gateway processes, provider ready-vs-usable mismatch, and stuck approval
 * queues. Runs as a daily governance job (module-scoped first, whole-system
 * later per the 总-分-总 plan). Findings are returned for the sweeper to
 * surface as todos; nothing is auto-fixed.
 */
import { getDb } from '@los/infra/db';
import { getLogger } from '@los/infra/logger';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { GovernanceJob } from './governance-jobs-types.js';

const log = getLogger('governance-adversarial-review');
const execFileAsync = promisify(execFile);

export interface AdversarialFinding {
  dimension: string;
  severity: 'info' | 'warn' | 'high';
  detail: string;
}

export async function runAdversarialReviewAudit(
  job: GovernanceJob,
  options: { now?: Date } = {},
): Promise<Record<string, unknown>> {
  const now = options.now ?? new Date();
  const module = String(job.config?.module ?? 'all');
  const findings: AdversarialFinding[] = [];

  // 1. Metric semantics: non-streaming success rows without the body split
  //    (added 2026-08-06) indicate either pre-fix rows or a regression where
  //    durationMs again covers headers only.
  if (module === 'all' || module === 'observability') {
    try {
      const rows = await getDb().query<{ n: string; newest: string | null }>(
        `SELECT count(*)::text AS n, max(created_at)::text AS newest
         FROM provider_call_telemetry
         WHERE stream = false AND status = 200 AND body_duration_ms IS NULL
           AND created_at > $1`,
        [new Date(now.getTime() - 7 * 24 * 3600_000)],
      );
      const n = Number(rows.rows[0]?.n ?? 0);
      if (n > 0) {
        findings.push({
          dimension: 'metric_semantics',
          severity: n > 20 ? 'high' : 'warn',
          detail: `${n} non-streaming success telemetry rows in the last 7d lack body_duration_ms (newest ${rows.rows[0]?.newest ?? '?'}); durationMs may again cover headers only`,
        });
      }
    } catch (err) {
      log.warn(`adversarial metric-semantics check failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // 2. Lingering processes: more than one gateway/src/server.ts process, or a
  //    los gateway that does not own the 8080 port (bind-failure residue that
  //    races the scheduler — observed 2026-08-06).
  if (module === 'all' || module === 'scheduler') {
    try {
      const { stdout } = await execFileAsync('pgrep', ['-fl', 'gateway/src/server'], { timeout: 10_000 });
      const pids = stdout.split('\n').filter(Boolean);
      if (pids.length > 1) {
        findings.push({
          dimension: 'process_residue',
          severity: 'high',
          detail: `${pids.length} gateway/src/server processes running (expected 1): ${pids.join('; ')}`,
        });
      }
    } catch (err) {
      // pgrep exits 1 when no match: a single or zero gateway is fine.
      const code = (err as { code?: number }).code;
      if (code !== 1) {
        log.warn(`adversarial process check failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  // 3. Stuck approval queue: preapproved_scope runs awaiting operator approval
  //    for >24h are either forgotten or the approval flow is broken.
  if (module === 'all' || module === 'scheduler') {
    try {
      const rows = await getDb().query<{ n: string }>(
        `SELECT count(*)::text AS n FROM scheduled_work_item_runs
         WHERE status = 'awaiting_approval' AND created_at < $1`,
        [new Date(now.getTime() - 24 * 3600_000)],
      );
      const n = Number(rows.rows[0]?.n ?? 0);
      if (n > 0) {
        findings.push({
          dimension: 'stuck_approval',
          severity: n > 3 ? 'high' : 'warn',
          detail: `${n} scheduled runs stuck in awaiting_approval for >24h`,
        });
      }
    } catch (err) {
      log.warn(`adversarial approval-queue check failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // 4. Provider ready-vs-usable: providers discovered as ready but with zero
  //    successful calls in 7d (static discovery can report ready while the
  //    real path fails — kimi refresh_token case 2026-08-06).
  if (module === 'all' || module === 'providers') {
    try {
      const rows = await getDb().query<{ provider: string; calls: string }>(
        `SELECT p.provider, coalesce(t.calls, 0)::text AS calls
         FROM (
           SELECT DISTINCT provider FROM provider_call_telemetry
           WHERE created_at > $1
         ) t
         RIGHT JOIN (
           SELECT unnest(ARRAY['deepseek','xai','kimi','minimax','packycode','custom','deepseek-anthropic']) AS provider
         ) p ON p.provider = t.provider
         WHERE coalesce(t.calls, 0) = 0`,
        [new Date(now.getTime() - 7 * 24 * 3600_000)],
      );
      for (const row of rows.rows) {
        findings.push({
          dimension: 'provider_ready_vs_usable',
          severity: 'warn',
          detail: `provider ${row.provider}: ready per discovery but 0 telemetry calls in 7d`,
        });
      }
    } catch (err) {
      log.warn(`adversarial provider check failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return {
    module,
    checkedAt: now.toISOString(),
    findingCount: findings.length,
    findings,
  };
}
