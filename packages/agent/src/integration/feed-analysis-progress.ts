import { withDbClient } from '@los/infra/db';
import {
  _insertFeedAnalysisCallbackEvent,
  ensureFeedAnalysisStore,
  type FeedAnalysisDispatchRow,
} from './feed-analysis-store.js';
import { FeedAnalysisError } from './feed-analysis-types.js';

export async function emitFeedAnalysisProgress(
  dispatchId: string,
  progress: { stage: string; title?: string; taskRunId?: string },
): Promise<void> {
  await ensureFeedAnalysisStore();
  await withDbClient(async client => {
    await client.query('BEGIN');
    try {
      const selected = await client.query<FeedAnalysisDispatchRow>(
        'SELECT * FROM feed_analysis_dispatches WHERE id=$1 FOR UPDATE', [dispatchId],
      );
      const current = selected.rows[0];
      if (!current) throw new FeedAnalysisError('dispatch_not_found', 'dispatch not found', 404);
      if (current.status !== 'processing') {
        throw new FeedAnalysisError('invalid_state', `cannot emit progress while dispatch is ${current.status}`, 409);
      }
      await _insertFeedAnalysisCallbackEvent(client, current, 'progress', undefined, undefined, progress);
      await client.query('COMMIT');
    } catch (cause) {
      await client.query('ROLLBACK');
      throw cause;
    }
  });
}
