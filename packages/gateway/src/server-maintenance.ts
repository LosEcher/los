/**
 * @los/gateway — server maintenance timers (orphan reaper, memory maintenance, governance sweep).
 *
 * Extracted from server.ts to keep both files under 400 lines.
 */
import type { FastifyInstance } from 'fastify';
import type { Config } from '@los/infra/config';
import { getLogger } from '@los/infra/logger';
import { reclaimOrphanedRuns } from './chat-session-helpers.js';
import { ensureGovernanceJobStore, seedGovernanceJobs, setupGovernanceWake, resumeAnsweredAsksForRunSpec, setupScheduledWorkWake } from '@los/agent';
import { listExecutorNodes, markStaleExecutorNodesOffline } from '@los/agent/executor-nodes';
import { markStaleServiceInstancesOffline } from '@los/agent/service-instances';
import { resolveCoordinationBackend } from '@los/agent/coordination';
import { processDueFeedAnalysisCallbacks, pruneExpiredFeedAnalysisMaterial } from '@los/agent';
import { publishExecutionOutboxBatch } from '@los/agent/execution-outbox';
import { reapExpiredExecutionLeases } from './execution-lease-reaper.js';
import { sweepSymbolCache } from './chat-cbm-symbol-cache.js';
import { registerDailyAgentQualityMaintenance } from './daily-agent-quality-maintenance.js';

export { reapExpiredExecutionLeases };

const log = getLogger('gateway');

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
  const ORPHAN_REAPER_MS = 30_000;
  const orphanReaper = setInterval(() => {
    reclaimOrphanedRuns(service.serviceId).then((result) => {
      if (result.claimedRunSpecIds.length > 0) {
        log.info(`Orphan reaper claimed ${result.claimedRunSpecIds.length} run(s) from stale gateways: ${result.staleGatewayIds.join(', ')}`);
      }
      if (result.errors.length > 0) log.warn(`Orphan reaper errors: ${result.errors.join('; ')}`);
    }).catch((err) => log.warn(`Orphan reaper failed: ${err.message ?? String(err)}`));
  }, ORPHAN_REAPER_MS);
  app.addHook('onClose', async () => clearInterval(orphanReaper));

  // ── Execution outbox publisher (1s) ────────────────────────
  const OUTBOX_POLL_MS = 1_000;
  let outboxPublishing = false;
  const publishExecutionOutbox = async () => {
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
  };
  const outboxTimeout = setTimeout(publishExecutionOutbox, 100);
  const outboxTimer = setInterval(publishExecutionOutbox, OUTBOX_POLL_MS);
  app.addHook('onClose', async () => {
    clearTimeout(outboxTimeout);
    clearInterval(outboxTimer);
  });

  const symbolCacheSweep = setInterval(() => sweepSymbolCache(), 60_000);
  app.addHook('onClose', async () => clearInterval(symbolCacheSweep));

  // ── Execution lease reaper (30s) ─────────────────────────────
  const reapExecutionLeases = () => reapExpiredExecutionLeases('gateway_periodic_reaper')
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
  const executionLeaseReaper = setInterval(reapExecutionLeases, ORPHAN_REAPER_MS);
  app.addHook('onClose', async () => clearInterval(executionLeaseReaper));

  // ── Feed-analysis callback delivery outbox ────────────────
  const callbackPollMs = config.integrations.feedAnalysis.callbackPollMs;
  const processFeedAnalysisCallbacks = async () => {
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
  };
  const callbackTimeout = setTimeout(processFeedAnalysisCallbacks, Math.min(1_000, callbackPollMs));
  const callbackTimer = setInterval(processFeedAnalysisCallbacks, callbackPollMs);
  app.addHook('onClose', async () => {
    clearTimeout(callbackTimeout);
    clearInterval(callbackTimer);
  });

  const MATERIAL_RETENTION_MS = 60 * 60 * 1000;
  const pruneFeedAnalysisMaterial = async () => {
    const pruned = await pruneExpiredFeedAnalysisMaterial().catch(error => {
      log.warn(`Feed-analysis material retention failed: ${error instanceof Error ? error.message : String(error)}`);
      return 0;
    });
    if (pruned > 0) log.info(`Feed-analysis material retention: pruned ${pruned} bundle(s)`);
  };
  const materialRetentionTimer = setInterval(pruneFeedAnalysisMaterial, MATERIAL_RETENTION_MS);
  app.addHook('onClose', async () => clearInterval(materialRetentionTimer));

  // ── Runtime registry freshness reconciliation (60s) ──────────
  const STALE_RECONCILE_MS = 60_000;
  const reconcileRuntimeFreshness = async () => {
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
  };
  const staleReconcileTimeout = setTimeout(reconcileRuntimeFreshness, STALE_RECONCILE_MS);
  const staleReconcileTimer = setInterval(reconcileRuntimeFreshness, STALE_RECONCILE_MS);
  app.addHook('onClose', async () => {
    clearTimeout(staleReconcileTimeout);
    clearInterval(staleReconcileTimer);
  });

  // ── Daily memory maintenance (retention + integrity + auto-compact) ──
  const RETENTION_MS = 24 * 60 * 60 * 1000;
  const runMemoryMaintenance = async () => {
    import('@los/memory').then(async ({ applyRetentionPolicy, checkMemoryIntegrity, compactSession, ensureMemoryCompactionStore }) => {
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
      // Auto-compact uncompacted sessions (>1h old, up to 10)
      try {
        const { getDb } = await import('@los/infra/db');
        await ensureMemoryCompactionStore();
        const db = getDb();
        const rows = await db.query<{ session_id: string }>(
          `SELECT DISTINCT o.session_id
           FROM observations o
           LEFT JOIN memory_compactions mc ON o.session_id = mc.session_id
           WHERE o.session_id IS NOT NULL
             AND mc.id IS NULL
             AND o.created_at < now() - INTERVAL '1 hour'
           LIMIT 10`,
        );
        const sessionIds = rows.rows.map(r => r.session_id).filter(Boolean);
        if (sessionIds.length > 0) {
          let compacted = 0;
          for (const sessionId of sessionIds) {
            try {
              const result = await compactSession({ sessionId });
              if (result) compacted += 1;
            } catch (err) {
              log.warn(`Auto-compact failed for session ${sessionId}: ${err instanceof Error ? err.message : String(err)}`);
            }
          }
          if (compacted > 0) log.info(`Auto-compact: compacted ${compacted}/${sessionIds.length} session(s)`);
        }
      } catch (err) {
        log.warn(`Auto-compact maintenance failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }).catch((err) => {
      log.warn(`Memory maintenance import failed: ${err instanceof Error ? err.message : String(err)}`);
    });
  };
  // Run once at startup, then daily
  const memoryMaintenanceTimeout = setTimeout(runMemoryMaintenance, 10_000);
  const retentionTimer = setInterval(runMemoryMaintenance, RETENTION_MS);
  app.addHook('onClose', async () => {
    clearTimeout(memoryMaintenanceTimeout);
    clearInterval(retentionTimer);
  });

  // ── Governance sweep wake (PG-queue claim loop) ──────────
  // Replaces the old setInterval(6h) sweep. Now uses:
  //   1. SKIP LOCKED claim loop — one job at a time, no stampede
  //   2. PG NOTIFY / EventBus for cross-process wake
  //   3. 10-min fallback interval for robustness
  //
  // Register onClose hook synchronously (before Fastify.listen) so it
  // works even when the wake starts asynchronously after listen.
  let govWakeTeardown: (() => void) | null = null;
  app.addHook('onClose', async () => {
    clearTimeout(govWakeTimeout);
    if (govWakeTeardown) { govWakeTeardown(); govWakeTeardown = null; }
  });

  const govWakeTimeout = setTimeout(() => {
    ensureGovernanceJobStore()
      .then(() => seedGovernanceJobs())
      .then(async () => {
        log.info('Governance: seeds ensured, starting PG-queue wake');
        govWakeTeardown = await setupGovernanceWake();
      })
      .catch((err) => log.warn(`Governance wake setup failed: ${err instanceof Error ? err.message : String(err)}`));
  }, 30_000);

  // ── Worker answer subscriber (PG NOTIFY listener for multi-gateway mesh) ──
  // The POST /runs/:id/answer route writes the answer + fire-and-forgets
  // resumeAnsweredAsksForRunSpec directly (active trigger in single-gateway).
  // This NOTIFY listener catches answers from other gateway processes in a mesh:
  // the answering gateway publishes 'worker_answer', and every gateway picks
  // it up to resume blocked tasks in parallel. Falls back to 30s poll interval
  // if PG LISTEN is unavailable.
  let unsubWorkerAnswer: (() => void) | null = null;
  const workerAnswerTimeout = setTimeout(() => {
    resolveCoordinationBackend().then(backend => {
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
      unsubWorkerAnswer = sub.unsubscribe;
      log.info('Worker answer: LISTEN on worker_answer channel active');
    }).catch((err) => log.warn(`Worker answer NOTIFY setup failed: ${err instanceof Error ? err.message : String(err)}`));
  }, 60_000);
  app.addHook('onClose', async () => {
    clearTimeout(workerAnswerTimeout);
    if (unsubWorkerAnswer) { unsubWorkerAnswer(); unsubWorkerAnswer = null; }
  });

  // ── File-sync orchestration trigger (every 5 minutes) ─────────
  const agentKey = opts?.executorAgentKey;
  if (agentKey) {
    const FILE_SYNC_TRIGGER_MS = 5 * 60 * 1000;
    const triggerFileSyncScans = async () => {
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
    };
    const fileSyncTimeout = setTimeout(triggerFileSyncScans, 30_000);
    const fileSyncTimer = setInterval(triggerFileSyncScans, FILE_SYNC_TRIGGER_MS);
    app.addHook('onClose', async () => {
      clearTimeout(fileSyncTimeout);
      clearInterval(fileSyncTimer);
    });
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
