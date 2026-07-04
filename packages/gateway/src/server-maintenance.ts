/**
 * @los/gateway — server maintenance timers (orphan reaper, memory maintenance, governance sweep).
 *
 * Extracted from server.ts to keep both files under 400 lines.
 */
import type { FastifyInstance } from 'fastify';
import { getLogger } from '@los/infra/logger';
import { reclaimOrphanedRuns } from './chat-session-helpers.js';
import { ensureGovernanceJobStore, seedGovernanceJobs, setupGovernanceWake, resumeAnsweredAsksForRunSpec } from '@los/agent';
import { listExecutorNodes } from '@los/agent/executor-nodes';
import { resolveCoordinationBackend } from '@los/agent/coordination';

const log = getLogger('gateway');

export function registerServerMaintenance(
  app: FastifyInstance,
  service: { serviceId: string },
  _config: unknown,
  opts?: { executorAgentKey?: string },
): void {
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
        for (const node of nodes) {
          const caps = (node.capabilities ?? {}) as Record<string, unknown>;
          if (!caps.file_sync_scan) continue;
          const cfg = (node.connectConfig ?? {}) as Record<string, unknown>;
          const httpCfg = (cfg.agent_http ?? {}) as Record<string, unknown>;
          const healthUrl = String(httpCfg.healthUrl ?? '').replace(/\/+$/, '');
          if (!healthUrl) continue;
          const folders = (Array.isArray(caps.file_sync_folders) ? caps.file_sync_folders : []) as unknown[];
          if (folders.length === 0) continue;
          for (const entry of folders) {
            const f = entry as Record<string, unknown>;
            const folderName = typeof f.name === 'string' ? f.name : typeof f.folder === 'string' ? f.folder : null;
            const mode = typeof f.mode === 'string' ? f.mode : 'incremental';
            if (!folderName) continue;
            try {
              await fetch(`${healthUrl.replace('/health', '')}/v1/file-sync/scan`, {
                method: 'POST',
                headers: {
                  Authorization: `Bearer ${agentKey}`,
                  'Content-Type': 'application/json',
                },
                body: JSON.stringify({ folder: folderName, mode }),
                signal: AbortSignal.timeout(300_000),
              });
              triggered++;
            } catch (err) {
              unreachable++;
              log.debug(`file-sync trigger: ${node.nodeId}/${folderName} unreachable (${err instanceof Error ? err.message : String(err)})`);
            }
          }
        }
        if (triggered > 0 || unreachable > 0) {
          log.info(`file-sync trigger: ${triggered} scan(s) triggered, ${unreachable} unreachable`);
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
