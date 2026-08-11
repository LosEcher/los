/**
 * @los/agent/governance-language-audit — Weekly Controlled Operator Language audit.
 *
 * Samples recent agent outputs (run_specs.result_json text + model.response
 * textPreview), scores them with language-contract.ts, persists a snapshot for
 * trend observation, and emits dimension findings for governance todos.
 *
 * Cadence: seed weekly. Config can promote to monthly after N clean windows
 * (autoPromoteCadence) or operator can set cadence=monthly later.
 */
import { createHash, randomUUID } from 'node:crypto';
import { getDb } from '@los/infra/db';
import { getLogger } from '@los/infra/logger';
import type { GovernanceCadence, GovernanceJob } from './governance-jobs-types.js';
import {
  DEFAULT_LANGUAGE_THRESHOLDS,
  LANGUAGE_CONTRACT_VERSION,
  aggregateLanguageScores,
  evaluateLanguageThresholds,
  scoreLanguageContract,
  type LanguageContractScore,
  type LanguageContractThresholds,
  type LanguageSampleMetrics,
  type LanguageThresholdFinding,
} from './language-contract.js';

const log = getLogger('governance-language-audit');

const SNAPSHOT_SCHEMA = `
CREATE TABLE IF NOT EXISTS language_contract_snapshots (
  id TEXT PRIMARY KEY,
  window_start TIMESTAMPTZ NOT NULL,
  window_end TIMESTAMPTZ NOT NULL,
  sample_count INTEGER NOT NULL DEFAULT 0,
  metrics_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  finding_count INTEGER NOT NULL DEFAULT 0,
  findings_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  cadence_recommendation TEXT,
  contract_version TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_language_contract_snapshots_created
  ON language_contract_snapshots(created_at DESC);
`;

let _snapshotReady = false;

export async function ensureLanguageContractSnapshotStore(): Promise<void> {
  if (_snapshotReady) return;
  await getDb().exec(SNAPSHOT_SCHEMA);
  _snapshotReady = true;
}

export interface LanguageAuditSample {
  source: 'run_spec_result' | 'model_response_preview';
  sourceId: string;
  text: string;
  createdAt?: string;
}

function readNumber(config: Record<string, unknown>, key: string, fallback: number): number {
  const raw = config[key];
  const n = typeof raw === 'number' ? raw : Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function readThresholds(config: Record<string, unknown>): LanguageContractThresholds {
  const nested = (config.thresholds && typeof config.thresholds === 'object' && !Array.isArray(config.thresholds))
    ? config.thresholds as Record<string, unknown>
    : {};
  return {
    evidenceMarkerRateMin: readNumber(nested, 'evidenceMarkerRateMin', DEFAULT_LANGUAGE_THRESHOLDS.evidenceMarkerRateMin),
    bareCompletionClaimRateMax: readNumber(nested, 'bareCompletionClaimRateMax', DEFAULT_LANGUAGE_THRESHOLDS.bareCompletionClaimRateMax),
    processNarrationRateMax: readNumber(nested, 'processNarrationRateMax', DEFAULT_LANGUAGE_THRESHOLDS.processNarrationRateMax),
    avgHedgeMax: readNumber(nested, 'avgHedgeMax', DEFAULT_LANGUAGE_THRESHOLDS.avgHedgeMax),
    meanComplianceMin: readNumber(nested, 'meanComplianceMin', DEFAULT_LANGUAGE_THRESHOLDS.meanComplianceMin),
  };
}

export async function loadLanguageAuditSamples(options: {
  lookbackDays: number;
  sampleLimit: number;
  minTextChars: number;
  now?: Date;
}): Promise<LanguageAuditSample[]> {
  const now = options.now ?? new Date();
  const since = new Date(now.getTime() - options.lookbackDays * 24 * 3600_000);
  const samples: LanguageAuditSample[] = [];
  const halfLimit = Math.max(1, Math.floor(options.sampleLimit / 2));

  try {
    const resultRows = await getDb().query<{ id: string; text: string; created_at: string }>(
      `SELECT id, result_json->>'text' AS text, created_at::text
       FROM run_specs
       WHERE result_json ? 'text'
         AND length(coalesce(result_json->>'text', '')) >= $1
         AND created_at >= $2
       ORDER BY created_at DESC
       LIMIT $3`,
      [options.minTextChars, since, halfLimit],
    );
    for (const row of resultRows.rows) {
      if (!row.text) continue;
      samples.push({
        source: 'run_spec_result',
        sourceId: row.id,
        text: row.text,
        createdAt: row.created_at,
      });
    }
  } catch (err) {
    log.warn(`language audit run_spec sample failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  try {
    const previewRows = await getDb().query<{ id: string; text: string; created_at: string }>(
      `SELECT id::text AS id,
              coalesce(payload_json->>'textPreview', '') AS text,
              created_at::text
       FROM session_events
       WHERE type = 'model.response'
         AND length(coalesce(payload_json->>'textPreview', '')) >= $1
         AND created_at >= $2
       ORDER BY created_at DESC
       LIMIT $3`,
      [options.minTextChars, since, options.sampleLimit - samples.length],
    );
    for (const row of previewRows.rows) {
      if (!row.text) continue;
      samples.push({
        source: 'model_response_preview',
        sourceId: row.id,
        text: row.text,
        createdAt: row.created_at,
      });
    }
  } catch (err) {
    log.warn(`language audit model.response sample failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  return samples.slice(0, options.sampleLimit);
}

function countConsecutiveCleanSnapshots(
  rows: Array<{ finding_count: number }>,
): number {
  let n = 0;
  for (const row of rows) {
    if (Number(row.finding_count) === 0) n += 1;
    else break;
  }
  return n;
}

/**
 * Run the language-contract audit for a governance job.
 */
export async function runLanguageAudit(
  job: GovernanceJob,
  options: { now?: Date; dryRun?: boolean } = {},
): Promise<Record<string, unknown>> {
  const now = options.now ?? new Date();
  const dryRun = options.dryRun === true;
  const lookbackDays = readNumber(job.config, 'lookbackDays', 7);
  const sampleLimit = Math.min(200, Math.max(10, readNumber(job.config, 'sampleLimit', 80)));
  const minTextChars = Math.max(20, readNumber(job.config, 'minTextChars', 40));
  const minSamplesForThresholds = Math.max(1, readNumber(job.config, 'minSamplesForThresholds', 8));
  const promoteAfterCleanRuns = Math.max(1, readNumber(job.config, 'promoteAfterCleanRuns', 4));
  const autoPromoteCadence = job.config.autoPromoteCadence === true;
  const promoteToCadence = (job.config.promoteToCadence === 'monthly' ? 'monthly' : 'monthly') as GovernanceCadence;
  const thresholds = readThresholds(job.config);

  const windowEnd = now;
  const windowStart = new Date(now.getTime() - lookbackDays * 24 * 3600_000);

  await ensureLanguageContractSnapshotStore();

  const samples = await loadLanguageAuditSamples({
    lookbackDays,
    sampleLimit,
    minTextChars,
    now,
  });

  const scores: LanguageContractScore[] = samples.map(s => scoreLanguageContract(s.text));
  const metrics: LanguageSampleMetrics = aggregateLanguageScores(scores);
  const findings: LanguageThresholdFinding[] = evaluateLanguageThresholds(metrics, thresholds, {
    minSamplesForThresholds,
  });

  // Cadence promotion: N consecutive clean snapshots (including current if clean).
  let cadenceRecommendation: string | undefined;
  let cadencePromoted = false;
  try {
    const prior = await getDb().query<{ finding_count: number }>(
      `SELECT finding_count FROM language_contract_snapshots
       ORDER BY created_at DESC LIMIT $1`,
      [promoteAfterCleanRuns],
    );
    const priorClean = countConsecutiveCleanSnapshots(prior.rows);
    const currentClean = findings.filter(f => f.severity !== 'info').length === 0
      && !findings.some(f => f.dimension === 'insufficient_samples');
    const cleanStreak = priorClean + (currentClean ? 1 : 0);

    if (currentClean && cleanStreak >= promoteAfterCleanRuns && job.cadence === 'weekly') {
      cadenceRecommendation = `monthly (clean streak ${cleanStreak} >= ${promoteAfterCleanRuns})`;
      findings.push({
        dimension: 'cadence_promotion_ready',
        severity: 'info',
        detail: `Language contract clean for ${cleanStreak} window(s). Recommend cadence weekly → monthly. Set autoPromoteCadence=true to apply automatically.`,
      });

      if (autoPromoteCadence && !dryRun) {
        const { updateGovernanceJob } = await import('./governance-jobs-crud.js');
        await updateGovernanceJob(job.id, { cadence: promoteToCadence });
        cadencePromoted = true;
        log.info(`language audit: promoted job ${job.id} cadence weekly → ${promoteToCadence}`);
      }
    }
  } catch (err) {
    log.warn(`language audit cadence promotion check failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  const actionableFindings = findings.filter(f => f.dimension !== 'cadence_promotion_ready' || f.severity !== 'info');
  // Todos should still see cadence_promotion_ready as info dimension; findingCount
  // for "has work" uses non-info or non-promotion dims.
  const workFindingCount = findings.filter(
    f => f.severity === 'warn' || f.severity === 'high',
  ).length;

  const topFlags = Object.entries(metrics.flagHistogram)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([flag, count]) => ({ flag, count }));

  const exampleIds = samples
    .filter((_, i) => scores[i] && scores[i]!.flags.length > 0)
    .slice(0, 5)
    .map(s => ({ source: s.source, sourceId: s.sourceId }));

  if (!dryRun) {
    try {
      const id = `lang-snap-${createHash('sha256')
        .update(`${windowStart.toISOString()}\0${windowEnd.toISOString()}\0${randomUUID()}`)
        .digest('hex')
        .slice(0, 16)}`;
      await getDb().query(
        `INSERT INTO language_contract_snapshots (
           id, window_start, window_end, sample_count, metrics_json,
           finding_count, findings_json, cadence_recommendation, contract_version
         ) VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7::jsonb,$8,$9)`,
        [
          id,
          windowStart.toISOString(),
          windowEnd.toISOString(),
          metrics.sampleCount,
          JSON.stringify(metrics),
          workFindingCount,
          JSON.stringify(findings),
          cadenceRecommendation ?? null,
          LANGUAGE_CONTRACT_VERSION,
        ],
      );
    } catch (err) {
      log.warn(`language audit snapshot insert failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return {
    auditedAt: now.toISOString(),
    contractVersion: LANGUAGE_CONTRACT_VERSION,
    lookbackDays,
    windowStart: windowStart.toISOString(),
    windowEnd: windowEnd.toISOString(),
    sampleCount: metrics.sampleCount,
    samplesBySource: {
      run_spec_result: samples.filter(s => s.source === 'run_spec_result').length,
      model_response_preview: samples.filter(s => s.source === 'model_response_preview').length,
    },
    metrics,
    thresholds,
    topFlags,
    exampleSourceIds: exampleIds,
    findingCount: findings.length,
    workFindingCount,
    findings,
    cadenceRecommendation: cadenceRecommendation ?? null,
    cadencePromoted,
  };
}
