/**
 * @los/gateway — server maintenance timers (orphan reaper, memory maintenance, governance sweep).
 *
 * Extracted from server.ts to keep both files under 400 lines.
 */
import type { FastifyInstance } from 'fastify';
import type { Config } from '@los/infra/config';
import type { DbConnection } from '@los/infra/db';
import { getLogger } from '@los/infra/logger';
import { reclaimOrphanedRuns } from './chat-session-helpers.js';
import { ensureGovernanceJobStore, seedGovernanceJobs, setupGovernanceWake, resumeAnsweredAsksForRunSpec, setupScheduledWorkWake } from '@los/agent';
import { listExecutorNodes, markStaleExecutorNodesOffline } from '@los/agent/executor-nodes';
import { markStaleServiceInstancesOffline } from '@los/agent/service-instances';
import { resolveCoordinationBackend } from '@los/agent/coordination';
import { processDueFeedAnalysisCallbacks, pruneExpiredFeedAnalysisMaterial } from '@los/agent';
import { publishExecutionOutboxBatch } from '@los/agent/execution-outbox';
import { reapExpiredExecutionLeases, recoverStaleRunningRunSpecs } from './execution-lease-reaper.js';
import { sweepSymbolCache } from './chat-cbm-symbol-cache.js';
import { registerDailyAgentQualityMaintenance } from './daily-agent-quality-maintenance.js';
import { registerNodeAutoProbe } from './node-auto-probe.js';

export { reapExpiredExecutionLeases, recoverStaleRunningRunSpecs };

const log = getLogger('gateway');

// ── Timer registration helpers ─────────────────────────────────
// Each helper owns its onClose teardown so registerServerMaintenance
// stays a thin assembly instead of a 400-line monolith.

/** Plain repeating timer. */
function registerIntervalTask(
  app: FastifyInstance,
  intervalMs: number,
  task: () => void,
): void {
  const timer = setInterval(task, intervalMs);
  app.addHook('onClose', async () => clearInterval(timer));
}

/** Runs once after initialDelayMs (default min(1s, interval)), then on intervalMs. */
function registerImmediateIntervalTask(
  app: FastifyInstance,
  intervalMs: number,
  task: () => void,
  initialDelayMs?: number,
): void {
  const initialDelay = initialDelayMs ?? Math.min(1_000, intervalMs);
  const timeout = setTimeout(task, initialDelay);
  const timer = setInterval(task, intervalMs);
  app.addHook('onClose', async () => {
    clearTimeout(timeout);
    clearInterval(timer);
  });
}

/** Async interval with single-flight execution and graceful shutdown. */
function registerAsyncIntervalTask(
  app: FastifyInstance,
  label: string,
  intervalMs: number,
  task: () => Promise<void>,
  initialDelayMs?: number,
): void {
  const initialDelay = initialDelayMs ?? Math.min(1_000, intervalMs);
  let closed = false;
  let running: Promise<void> | null = null;
  const invoke = (): void => {
    if (closed || running) return;
    running = Promise.resolve()
      .then(task)
      .catch((error) => {
        log.warn(`${label} failed: ${error instanceof Error ? error.message : String(error)}`);
      })
      .finally(() => { running = null; });
  };
  const timeout = setTimeout(invoke, initialDelay);
  const timer = setInterval(invoke, intervalMs);
  app.addHook('onClose', async () => {
    closed = true;
    clearTimeout(timeout);
    clearInterval(timer);
    if (running) await running;
  });
}

/** One-shot async setup after delayMs; the resolved cleanup runs on onClose. */
function registerAsyncSetupTask(
  app: FastifyInstance,
  label: string,
  delayMs: number,
  setup: () => Promise<(() => void) | void>,
): void {
  let teardown: (() => void) | null = null;
  let timeout: NodeJS.Timeout;
  // Register hook synchronously (before Fastify.listen) so it works even
  // when the async setup resolves after listen.
  app.addHook('onClose', async () => {
    clearTimeout(timeout);
    if (teardown) {
      teardown();
      teardown = null;
    }
  });
  timeout = setTimeout(() => {
    setup()
      .then((cleanup) => {
        teardown = cleanup ?? null;
      })
      .catch((err) => log.warn(`${label} setup failed: ${err instanceof Error ? err.message : String(err)}`));
  }, delayMs);
}

// ── Task implementations (module-scope so register stays thin) ──

async function reconcileRuntimeFreshness(): Promise<void> {
  try {
    const [nodes, services] = await Promise.all([
      markStaleExecutorNodesOffline(),
      markStaleServiceInstancesOffline(),
    ]);
    if (nodes.updated.length > 0 || services.updated.length > 0) {
      log.info(
        `Runtime freshness: marked ${nodes.updated.length} executor node(s) and ` +
        `${services.updated.length} service instance(s) offline after stale heartbeat`,
      );
    }
  } catch (err) {
    log.warn(`Runtime freshness reconciliation failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Select sessions that accumulated observations since their last compaction.
 * Candidate = session with at least one non-archived, non-compacted observation
 * ("new observations" semantics). Sessions whose observations were all processed
 * by a previous compaction are excluded.
 */
export interface AutoCompactCandidate {
  sessionId: string;
  oldestObs: string;
  obsCount: string;
}

export async function selectAutoCompactCandidates(
  db: DbConnection,
  limit = 20,
): Promise<AutoCompactCandidate[]> {
  const rows = await db.query<{ session_id: string; oldest_obs: string; obs_count: string }>(
    `SELECT o.session_id,
            MIN(o.created_at)::text AS oldest_obs,
            COUNT(*)::text AS obs_count
     FROM observations o
     WHERE o.session_id IS NOT NULL
       AND COALESCE(o.metadata_json->>'archived', 'false') = 'false'
       AND COALESCE(o.metadata_json->>'compacted', 'false') = 'false'
     GROUP BY o.session_id
     ORDER BY MIN(o.created_at)
     LIMIT $1`,
    [String(limit)],
  );
  return rows.rows.map(r => ({ sessionId: r.session_id, oldestObs: r.oldest_obs, obsCount: r.obs_count }));
}

/**
 * Compaction failure compensation (optimization plan P0-3).
 *
 * compactSession failures used to be silent (decay path) or single-line warn
 * (safety net). Now every failure is counted per session; retries respect an
 * exponential backoff (1h × 2^(failCount-1), capped at 24h — the maintenance
 * loop runs daily, so a session in backoff is skipped until the window
 * elapses), and a warn is emitted with the attempt count. A successful
 * compaction clears the session's failure state.
 */
interface CompactionFailureState {
  failCount: number;
  lastFailAt: number;
}

const COMPACTION_BACKOFF = new Map<string, CompactionFailureState>();

const COMPACTION_BACKOFF_BASE_MS = 3600_000; // 1h
const COMPACTION_BACKOFF_CAP_MS = 24 * 3600_000; // 24h

export function _recordCompactionFailure(sessionId: string, now = Date.now()): number {
  const entry = COMPACTION_BACKOFF.get(sessionId) ?? { failCount: 0, lastFailAt: 0 };
  entry.failCount += 1;
  entry.lastFailAt = now;
  COMPACTION_BACKOFF.set(sessionId, entry);
  return entry.failCount;
}

export function _compactionBackoffElapsed(sessionId: string, now = Date.now()): boolean {
  const entry = COMPACTION_BACKOFF.get(sessionId);
  if (!entry) return true;
  const backoffMs = Math.min(
    COMPACTION_BACKOFF_CAP_MS,
    COMPACTION_BACKOFF_BASE_MS * 2 ** Math.max(0, entry.failCount - 1),
  );
  return now - entry.lastFailAt >= backoffMs;
}

export function _clearCompactionFailure(sessionId: string): void {
  COMPACTION_BACKOFF.delete(sessionId);
}

export function _resetCompactionBackoff(): void {
  COMPACTION_BACKOFF.clear();
}

async function runMemoryMaintenance(): Promise<void> {
  try {
    const {
      applyRetentionPolicy,
      checkMemoryIntegrity,
      compactSession,
      ensureMemoryCompactionStore,
      shouldTriggerCompaction,
      archiveStaleObservations,
    } = await import('@los/memory');
    const retention = await applyRetentionPolicy().catch((err) => {
      log.warn(`Memory retention failed: ${err.message ?? String(err)}`);
      return null;
    });
    if (retention && (retention.archivedCount > 0 || retention.deletedCount > 0)) {
      log.info(`Memory retention: archived ${retention.archivedCount}, deleted ${retention.deletedCount}`);
    }
    const integrity = await checkMemoryIntegrity().catch((err) => {
      log.warn(`Memory integrity check failed: ${err.message ?? String(err)}`);
      return null;
    });
    if (integrity && integrity.checks && integrity.checks.length > 0) {
      const failed = integrity.checks.filter(c => c.severity === 'error');
      if (failed.length > 0) {
        log.warn(`Memory integrity: ${failed.length} error(s) — ${failed.slice(0, 3).map(c => c.name).join('; ')}`);
      }
    }
    // Auto-compact: decay-triggered (low score / high stale) + 24h safety net
    try {
      const { getDb } = await import('@los/infra/db');
      await ensureMemoryCompactionStore();
      const db = getDb();

      const candidates = await selectAutoCompactCandidates(db);

      let decayCompacted = 0;
      let scheduledCompacted = 0;
      let autoArchived = 0;
      const SAFETY_NET_HOURS = 24;

      for (const { sessionId, oldestObs, obsCount } of candidates) {
        const obsCountNum = Number(obsCount);
        const oldest = new Date(oldestObs);
        const hoursSinceOldest = (Date.now() - oldest.getTime()) / 3_600_000;

        // Rule 1: decay-based trigger
        try {
          const decision = await shouldTriggerCompaction(sessionId);
          if (decision.triggered) {
            if (!_compactionBackoffElapsed(sessionId)) continue;
            try {
              // force=true: bypass compactSession dedup so sessions compacted by
              // event-driven checkpoints can be re-compacted on new observations.
              await compactSession({ sessionId, autoTrigger: 'decay', force: true });
              _clearCompactionFailure(sessionId);
              decayCompacted += 1;
            } catch (err) {
              const fails = _recordCompactionFailure(sessionId);
              log.warn(`Decay compact failed for ${sessionId} (attempt ${fails}): ${err instanceof Error ? err.message : String(err)}`);
            }
            continue;
          }
        } catch (err) {
          log.debug(`Decay check skipped for ${sessionId}: ${err instanceof Error ? err.message : String(err)}`);
        }

        // Auto-marking: archive individually stale plain observations (approved
        // operator policy); runs even when the session does not trigger compaction.
        try {
          const marked = await archiveStaleObservations(sessionId);
          autoArchived += marked.archivedCount;
        } catch (err) {
          log.debug(`Auto-marking skipped for ${sessionId}: ${err instanceof Error ? err.message : String(err)}`);
        }

        // Rule 2: 24h safety net for sessions with at least some observations
        if (obsCountNum >= 10 && hoursSinceOldest >= SAFETY_NET_HOURS && _compactionBackoffElapsed(sessionId)) {
          try {
            await compactSession({ sessionId, autoTrigger: 'scheduled', force: true });
            _clearCompactionFailure(sessionId);
            scheduledCompacted += 1;
          } catch (err) {
            const fails = _recordCompactionFailure(sessionId);
            log.warn(`Safety-net compact failed for ${sessionId} (attempt ${fails}): ${err instanceof Error ? err.message : String(err)}`);
          }
        }
      }

      if (decayCompacted > 0 || scheduledCompacted > 0) {
        log.info(`Auto-compact: decay=${decayCompacted}, scheduled=${scheduledCompacted}`);
      }
    } catch (err) {
      log.warn(`Auto-compact maintenance failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  } catch (err) {
    log.warn(`Memory maintenance import failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function triggerFileSyncScans(agentKey: string): Promise<void> {
  try {
    const nodes = await listExecutorNodes();
    let triggered = 0;
    let unreachable = 0;
    let skippedUnavailable = 0;
    let skippedOverlapping = 0;
    for (const node of nodes) {
      if (isRuntimeNodeUnavailableForScan(node)) {
        skippedUnavailable++;
        continue;
      }
      const caps = (node.capabilities ?? {}) as Record<string, unknown>;
      if (!caps.file_sync_scan) continue;
      const cfg = (node.connectConfig ?? {}) as Record<string, unknown>;
      const httpCfg = (cfg.agent_http ?? {}) as Record<string, unknown>;
      const healthUrl = String(httpCfg.healthUrl ?? '').replace(/\/+$/, '');
      if (!healthUrl) continue;
      const allFolders = (Array.isArray(caps.file_sync_folders) ? caps.file_sync_folders : []) as unknown[];
      const { folders, skipped } = normalizeFileSyncFoldersForScan(allFolders);
      skippedOverlapping += skipped;
      if (folders.length === 0) continue;
      for (const entry of folders) {
        try {
          await fetch(`${healthUrl.replace('/health', '')}/v1/file-sync/scan`, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${agentKey}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ folder: entry.folderName, mode: entry.mode }),
            signal: AbortSignal.timeout(300_000),
          });
          triggered++;
        } catch (err) {
          unreachable++;
          log.debug(`file-sync trigger: ${node.nodeId}/${entry.folderName} unreachable (${err instanceof Error ? err.message : String(err)})`);
        }
      }
    }
    if (triggered > 0 || unreachable > 0 || skippedUnavailable > 0 || skippedOverlapping > 0) {
      log.info(
        `file-sync trigger: ${triggered} scan(s) triggered, ${unreachable} unreachable, ` +
        `${skippedUnavailable} unavailable node(s) skipped, ${skippedOverlapping} overlapping folder(s) skipped`,
      );
    }
  } catch (err) {
    log.warn(`file-sync trigger sweep failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export function registerServerMaintenance(
  app: FastifyInstance,
  service: { serviceId: string },
  config: Config,
  opts?: { executorAgentKey?: string },
): void {
  registerDailyAgentQualityMaintenance(app, config.defaultProjectId ?? 'los');
  const stopScheduledWork = setupScheduledWorkWake({ ownerId: service.serviceId });
  app.addHook('onClose', async () => stopScheduledWork());

  // ── Orphan reaper (30s) ──────────────────────────────────────
  registerIntervalTask(app, 30_000, () => {
    reclaimOrphanedRuns(service.serviceId).then((result) => {
      if (result.claimedRunSpecIds.length > 0) {
        log.info(`Orphan reaper claimed ${result.claimedRunSpecIds.length} run(s) from stale gateways: ${result.staleGatewayIds.join(', ')}`);
      }
      if (result.errors.length > 0) log.warn(`Orphan reaper errors: ${result.errors.join('; ')}`);
    }).catch((err) => log.warn(`Orphan reaper failed: ${err.message ?? String(err)}`));
  });

  // ── Execution outbox publisher (1s) ────────────────────────
  let outboxPublishing = false;
  registerImmediateIntervalTask(app, 1_000, async () => {
    if (outboxPublishing) return;
    outboxPublishing = true;
    try {
      const result = await publishExecutionOutboxBatch({ ownerId: service.serviceId });
      if (result.claimed > 0) {
        log.info(
          `Execution outbox: claimed=${result.claimed}, published=${result.published}, retried=${result.retried}`,
        );
      }
    } catch (error) {
      log.warn(`Execution outbox publisher failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      outboxPublishing = false;
    }
  });

  registerIntervalTask(app, 60_000, () => sweepSymbolCache());

  // ── Execution lease reaper (30s) ─────────────────────────────
  registerIntervalTask(app, 30_000, () => {
    reapExpiredExecutionLeases('gateway_periodic_reaper')
      .then((result) => {
        if (result.taskRuns > 0 || result.agentTasks > 0) {
          log.info(
            `Execution lease reaper: taskRuns=${result.taskRuns}, ` +
            `agentTasks=${result.agentTasks}, exhaustedAgentTasks=${result.exhaustedAgentTasks}`,
          );
        }
      })
      .catch((error) => log.warn(
        `Execution lease reaper failed: ${error instanceof Error ? error.message : String(error)}`,
      ));
  });

  // ── Stale-running run_spec recovery (60s) ───────────────────
  // V2 observability task: run_specs stuck in `running` with no active task
  // and no update for 30min are transitioned to blocked via the state machine.
  registerImmediateIntervalTask(app, 60_000, () => {
    recoverStaleRunningRunSpecs()
      .catch((error) => log.warn(
        `Stale-running recovery failed: ${error instanceof Error ? error.message : String(error)}`,
      ));
  });

  // ── Feed-analysis callback delivery outbox ────────────────
  const callbackPollMs = config.integrations.feedAnalysis.callbackPollMs;
  registerImmediateIntervalTask(app, callbackPollMs, async () => {
    try {
      const result = await processDueFeedAnalysisCallbacks(
        config.integrations.feedAnalysis.callbackProfiles,
        { ownerId: service.serviceId },
      );
      if (result.claimed > 0) {
        log.info(
          `Feed-analysis callbacks: claimed=${result.claimed}, delivered=${result.delivered}, ` +
          `retried=${result.retried}, deadLettered=${result.deadLettered}`,
        );
      }
    } catch (error) {
      log.warn(`Feed-analysis callback delivery failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  });

  const MATERIAL_RETENTION_MS = 60 * 60 * 1000;
  registerIntervalTask(app, MATERIAL_RETENTION_MS, async () => {
    const pruned = await pruneExpiredFeedAnalysisMaterial().catch(error => {
      log.warn(`Feed-analysis material retention failed: ${error instanceof Error ? error.message : String(error)}`);
      return 0;
    });
    if (pruned > 0) log.info(`Feed-analysis material retention: pruned ${pruned} bundle(s)`);
  });

  // ── Runtime registry freshness reconciliation (60s) ──────────
  registerImmediateIntervalTask(app, 60_000, () => void reconcileRuntimeFreshness(), 60_000);

  // ── Rate-limited auto-probe for online-but-unverified executors ──
  // Restores candidate=true after heartbeat recovery without operator POST /probe.
  // Caps: 2 probes / 120s tick, 2s gap, 5m per-node cooldown (see node-auto-probe.ts).
  registerNodeAutoProbe(app);

  // ── Daily memory maintenance (retention + integrity + auto-compact) ──
  const RETENTION_MS = 24 * 60 * 60 * 1000;
  registerAsyncIntervalTask(app, 'Memory maintenance', RETENTION_MS, runMemoryMaintenance, 10_000);

  // ── Governance sweep wake (PG-queue claim loop) ──────────
  // Replaces the old setInterval(6h) sweep. Now uses:
  //   1. SKIP LOCKED claim loop — one job at a time, no stampede
  //   2. PG NOTIFY / EventBus for cross-process wake
  //   3. 10-min fallback interval for robustness
  registerAsyncSetupTask(app, 'Governance wake', 30_000, async () => {
    await ensureGovernanceJobStore();
    await seedGovernanceJobs();
    log.info('Governance: seeds ensured, starting PG-queue wake');
    return setupGovernanceWake();
  });

  // ── Worker answer subscriber (PG NOTIFY listener for multi-gateway mesh) ──
  // The POST /runs/:id/answer route writes the answer + fire-and-forgets
  // resumeAnsweredAsksForRunSpec directly (active trigger in single-gateway).
  // This NOTIFY listener catches answers from other gateway processes in a mesh:
  // the answering gateway publishes 'worker_answer', and every gateway picks
  // it up to resume blocked tasks in parallel. Falls back to 30s poll interval
  // if PG LISTEN is unavailable.
  registerAsyncSetupTask(app, 'Worker answer NOTIFY', 60_000, async () => {
    const backend = await resolveCoordinationBackend();
    const sub = backend.notify.subscribeWithFallback(
      'worker_answer',
      (payload: unknown) => {
        try {
          const p = payload as Record<string, unknown>;
          const runSpecId = typeof p?.runSpecId === 'string' ? p.runSpecId : null;
          if (runSpecId) {
            void resumeAnsweredAsksForRunSpec(runSpecId).catch(() => undefined);
          }
        } catch {
          // best-effort: malformed payload is logged at NOTIFY level by pg-backend
        }
      },
      30_000, // poll every 30s as fallback
    );
    log.info('Worker answer: LISTEN on worker_answer channel active');
    return sub.unsubscribe;
  });

  // ── File-sync orchestration trigger (every 5 minutes) ─────────
  const agentKey = opts?.executorAgentKey;
  if (agentKey) {
    const FILE_SYNC_TRIGGER_MS = 5 * 60 * 1000;
    registerImmediateIntervalTask(app, FILE_SYNC_TRIGGER_MS, () => void triggerFileSyncScans(agentKey), 30_000);
  }
}

type RuntimeNodeForScan = Awaited<ReturnType<typeof listExecutorNodes>>[number];

interface FileSyncFolderForScan {
  folderName: string;
  mode: string;
  path?: string;
}

function isRuntimeNodeUnavailableForScan(node: RuntimeNodeForScan): boolean {
  if (node.status !== 'online') return true;
  return node.execution.blockers.some(blocker => blocker === 'heartbeat:stale' || blocker.startsWith('status:'));
}

function normalizeFileSyncFoldersForScan(entries: unknown[]): { folders: FileSyncFolderForScan[]; skipped: number } {
  const parsed = entries
    .map(parseFileSyncFolder)
    .filter((entry): entry is FileSyncFolderForScan => Boolean(entry))
    .sort((a, b) => (a.path?.length ?? Number.MAX_SAFE_INTEGER) - (b.path?.length ?? Number.MAX_SAFE_INTEGER));
  const folders: FileSyncFolderForScan[] = [];
  let skipped = 0;

  for (const entry of parsed) {
    if (folders.some(existing => foldersOverlap(existing, entry))) {
      skipped++;
      continue;
    }
    folders.push(entry);
  }

  return { folders, skipped };
}

function parseFileSyncFolder(entry: unknown): FileSyncFolderForScan | null {
  if (!entry || typeof entry !== 'object') return null;
  const record = entry as Record<string, unknown>;
  const folderName = typeof record.name === 'string'
    ? record.name.trim()
    : typeof record.folder === 'string'
      ? record.folder.trim()
      : '';
  if (!folderName) return null;
  const mode = typeof record.mode === 'string' && record.mode.trim() ? record.mode.trim() : 'incremental';
  const path = typeof record.path === 'string' && record.path.trim() ? normalizePathForOverlap(record.path) : undefined;
  return { folderName, mode, path };
}

function foldersOverlap(existing: FileSyncFolderForScan, next: FileSyncFolderForScan): boolean {
  if (existing.path && next.path) {
    return next.path === existing.path || next.path.startsWith(`${existing.path}/`);
  }
  return existing.folderName === next.folderName;
}

function normalizePathForOverlap(value: string): string {
  return value.trim().replace(/\\/g, '/').replace(/\/+$/, '');
}
