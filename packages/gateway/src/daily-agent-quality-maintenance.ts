import type { FastifyInstance } from 'fastify';

import {
  captureDailyAgentQuality,
  listDailyAgentQualityScopes,
  type DailyAgentQualityScope,
} from '@los/agent/daily-agent-quality';
import { getLogger } from '@los/infra/logger';

const log = getLogger('gateway');
const STARTUP_DELAY_MS = 15_000;
const DAILY_CAPTURE_MS = 24 * 60 * 60 * 1000;

export function registerDailyAgentQualityMaintenance(
  app: FastifyInstance,
  defaultProjectId: string,
): void {
  let running = false;
  const captureScopes = async () => {
    if (running) return;
    running = true;
    try {
      const discovered = await listDailyAgentQualityScopes();
      const scopes = uniqueScopes([
        { tenantId: 'local', projectId: defaultProjectId },
        ...discovered,
      ]);
      let captured = 0;
      for (const scope of scopes) {
        try {
          await captureDailyAgentQuality(scope);
          captured += 1;
        } catch (error) {
          log.warn(
            `Daily agent quality capture failed for ${scope.tenantId}/${scope.projectId}: `
            + `${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      if (captured > 0) log.info(`Daily agent quality: captured ${captured}/${scopes.length} project scope(s)`);
    } catch (error) {
      log.warn(`Daily agent quality scope discovery failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      running = false;
    }
  };
  const startup = setTimeout(captureScopes, STARTUP_DELAY_MS);
  const timer = setInterval(captureScopes, DAILY_CAPTURE_MS);
  app.addHook('onClose', async () => {
    clearTimeout(startup);
    clearInterval(timer);
  });
}

function uniqueScopes(scopes: DailyAgentQualityScope[]): DailyAgentQualityScope[] {
  const seen = new Set<string>();
  return scopes.filter(scope => {
    if (!scope.tenantId || !scope.projectId) return false;
    const key = `${scope.tenantId}\0${scope.projectId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
