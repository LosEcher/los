/**
 * eval-backlog-scheduler.ts — Periodic eval backlog snapshot recording.
 *
 * Triggered by the gateway's daily maintenance timer to ensure eval backlog
 * snapshots are captured automatically, not just manually via the API.
 */

import { recordEvalBacklogSnapshot } from '../eval-backlog-runner.js';
import { getLogger } from '@los/infra/logger';

const log = getLogger('eval-backlog-scheduler');

/**
 * Run an eval backlog snapshot. Called periodically by the gateway.
 * Best-effort: failures are logged but never thrown.
 */
export async function runEvalBacklogSnapshot(): Promise<void> {
  try {
    const snapshot = await recordEvalBacklogSnapshot({ triggeredBy: 'scheduler' });
    log.info('Eval backlog snapshot recorded', {
      recorded: snapshot.recorded,
      automated: snapshot.automated,
      manual: snapshot.manual,
    });
  } catch (err) {
    log.warn(`Eval backlog snapshot failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}
