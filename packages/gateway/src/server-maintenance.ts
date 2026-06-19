/**
 * @los/gateway — server maintenance timers (orphan reaper, memory maintenance, governance sweep).
 *
 * Extracted from server.ts to keep both files under 400 lines.
 */
import type { FastifyInstance } from 'fastify';
import { getLogger } from '@los/infra/logger';
import { reclaimOrphanedRuns } from './chat-session-helpers.js';

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

  // ── Daily governance sweep ─────────────────────────────────────
  const GOVERNANCE_SWEEP_MS = 24 * 60 * 60 * 1000;
  const runGovernanceMaintenance = async () => {
    import('@los/agent').then(async ({ ensureGovernanceJobStore, seedGovernanceJobs, runGovernanceSweep }) => {
      try {
        await ensureGovernanceJobStore();
        await seedGovernanceJobs();
        const result = await runGovernanceSweep({ dryRun: false });
        if (result.jobsRun > 0) {
          log.info(`Governance sweep: ${result.jobsRun} job(s) run, ${result.findingsCreated} finding(s)`);
        }
        if (result.errors.length > 0) {
          log.warn(`Governance sweep errors: ${result.errors.join('; ')}`);
        }
      } catch (err) {
        log.warn(`Governance sweep failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }).catch((err) => {
      log.warn(`Governance sweep import failed: ${err instanceof Error ? err.message : String(err)}`);
    });
  };
  const governanceTimeout = setTimeout(runGovernanceMaintenance, 30_000);
  const governanceTimer = setInterval(runGovernanceMaintenance, GOVERNANCE_SWEEP_MS);
  app.addHook('onClose', async () => {
    clearTimeout(governanceTimeout);
    clearInterval(governanceTimer);
  });

  // ── File-sync orchestration trigger (every 5 minutes) ─────────
  const agentKey = opts?.executorAgentKey;
  if (agentKey) {
    const FILE_SYNC_TRIGGER_MS = 5 * 60 * 1000;
    const triggerFileSyncScans = async () => {
      try {
        const { listExecutorNodes } = await import('@los/agent/executor-nodes');
        const nodes = await listExecutorNodes();
        for (const node of nodes) {
          const caps = (node.capabilities ?? {}) as Record<string, unknown>;
          if (!caps.file_sync_scan) continue;
          const cfg = (node.connectConfig ?? {}) as Record<string, unknown>;
          const httpCfg = (cfg.agent_http ?? {}) as Record<string, unknown>;
          const healthUrl = String(httpCfg.healthUrl ?? '').replace(/\/+$/, '');
          if (!healthUrl) continue;
          try {
            await fetch(`${healthUrl.replace('/health', '')}/v1/file-sync/scan`, {
              method: 'POST',
              headers: {
                Authorization: `Bearer ${agentKey}`,
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({ mode: 'incremental' }),
              signal: AbortSignal.timeout(300_000),
            });
          } catch {
            // node unreachable, skip
          }
        }
      } catch (err) {
        // gateway may not have executor-nodes loaded yet
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
